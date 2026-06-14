import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon } from '../ui';
import {
  CELL, BALL_R, CUP_R, POST_R, STEP, MAX_POWER, HOLES_PER_ROUND,
  HAIR_COLORS, SKIN_COLORS, OUTFIT_COLORS, DEFAULT_CHARACTER, CellType,
  initHole, stepHole, strike, dragToShot, speed, fmtMillis, scoreLabel, barEndpoints, cellAt,
  type CharacterLook, type HoleDef, type HoleState, type Vec,
} from './engine';
import { arcadeMusic } from './music';

// ==========================================
// Mini Golf — fixed isometric voxel renderer.
// The course grid renders as flat-shaded voxel cubes (solid saturated
// colors, three-tone directional lighting from the NW, sharp SE shadows) on
// a strict 2:1-style isometric projection. The golfer vanishes the instant
// the ball is struck and reappears only once it has come to rest.
// ==========================================

const K = 0.55;                          // iso scale: sx = (x−y)·K
const OX = 332, OY = 70;                 // projection origin on the canvas
const CANVAS_W = 860, CANVAS_H = 510;
const WALL_Z = 10;                       // wall cube height ≈ 2/3 of the ball (never hides it)

// Flat-shaded voxel palette (saturated, vector-style).
const PAL = {
  grassA: '#3ec46a', grassB: '#36b860',
  slope: '#2da455',
  sand: '#efd98a', sandDot: '#c9ad55',
  water: '#3f9bee', waterHi: '#7fc0f6',
  wallTop: '#e0b667', wallL: '#b58a45', wallR: '#8a672e',
  postTop: '#d9a85b', postSide: '#9a743a',
  shadow: 'rgba(10, 25, 14, 0.22)',
};

const iso = (x: number, y: number, z: number): Vec => ({
  x: (x - y) * K + OX,
  y: (x + y) * K * 0.5 - z + OY,
});

const unproject = (sx: number, sy: number): Vec => {
  const a = (sx - OX) / K;           // x − y
  const b = (sy - OY) * 2 / K;       // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
};

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
}

export default function MiniGolf({ course, character, fullAccess, onHoleSunk, onRoundComplete, onExit, onGoParticipate, submitNote }: MiniGolfProps) {
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
      return unproject(sx, sy);
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
              if (g.holeIdx === HOLES_PER_ROUND - 1) {
                g.finalMs = g.roundStartedAt ? performance.now() - g.roundStartedAt : 0;
                setClockMs(g.finalMs);
                if (!g.completed) {
                  g.completed = true;
                  onRoundComplete(nextPerHole, Math.round(g.finalMs));
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

      render(ctx, g, now / 1000, look);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [look.hair, look.skin, look.outfit, onRoundComplete]);

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
    <div className="col" style={{ gap: 10, position: 'relative' }}>
      {/* HUD strip */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <b style={{ fontSize: 14 }}>Hole {holeIdx + 1}/9 · {def.name}</b>
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

      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-hi)' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: 'crosshair', background: '#101813' }}
        />

        {/* Hole intro card */}
        {phase === 'intro' && (
          <Overlay>
            <span className="mono" style={{ fontSize: 11, color: 'var(--burn-ink)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Hole {holeIdx + 1} of 9</span>
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

        {/* Participation gate after hole 1 */}
        {phase === 'gate' && (
          <Overlay>
            <Icon name="lock" size={26} stroke="var(--haze-ink)" />
            <h3 style={{ margin: 0 }}>That's the free preview</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13, maxWidth: 380, textAlign: 'center' }}>
              Holes 2–9 (and the leaderboard) unlock for protocol participants: stake any
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
            {submitNote && <span style={{ fontSize: 12.5, color: 'var(--burn-ink)' }}>{submitNote}</span>}
            <Btn variant="primary" onClick={onExit}>Back to Arcade</Btn>
          </Overlay>
        )}
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
        Drag back from the ball to aim — farther = harder. Sand slows, water costs a stroke, slopes push (chevrons), 12-stroke pickup.
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
// Isometric voxel renderer
// ==========================================

function poly(ctx: CanvasRenderingContext2D, pts: Vec[], fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
}

/** The four iso ground corners of one cell: [top, right, bottom, left]. */
function cellCorners(gx: number, gy: number, z = 0): Vec[] {
  const x0 = gx * CELL, y0 = gy * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
  return [iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)];
}

/** Flat-shaded voxel cube on cell (gx,gy): top + the two camera-facing sides. */
function drawCube(ctx: CanvasRenderingContext2D, gx: number, gy: number, z: number, top: string, left: string, right: string) {
  const g = cellCorners(gx, gy, 0);
  const t = cellCorners(gx, gy, z);
  poly(ctx, [t[3], t[2], g[2], g[3]], left);   // SW face
  poly(ctx, [t[1], t[2], g[2], g[1]], right);  // SE face
  poly(ctx, t, top);
}

/** Small free-standing prism (windmill segment, post body). */
function drawPrism(ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number, z0: number, z1: number, top: string, left: string, right: string) {
  const c = (z: number) => [
    iso(cx - half, cy - half, z), iso(cx + half, cy - half, z),
    iso(cx + half, cy + half, z), iso(cx - half, cy + half, z),
  ];
  const g = c(z0), t = c(z1);
  poly(ctx, [t[3], t[2], g[2], g[3]], left);
  poly(ctx, [t[1], t[2], g[2], g[1]], right);
  poly(ctx, t, top);
}

function render(ctx: CanvasRenderingContext2D, g: GameRef, tSec: number, look: CharacterLook) {
  const { def, state } = g;
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Backdrop.
  const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  bg.addColorStop(0, '#15201a');
  bg.addColorStop(1, '#0c120e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // ── Ground pass (painter's order: diagonals of gx+gy) ──
  for (let s = 0; s <= def.w + def.h - 2; s++) {
    for (let gx = Math.max(0, s - def.h + 1); gx <= Math.min(def.w - 1, s); gx++) {
      const gy = s - gx;
      drawGroundCell(ctx, def, gx, gy, tSec);
    }
  }

  // Cup (flat, on the ground).
  drawCup(ctx, def);

  // ── Raised pass: everything with height, depth-sorted by world x+y ──
  const items: { key: number; draw: () => void }[] = [];
  for (let gy = 0; gy < def.h; gy++) {
    for (let gx = 0; gx < def.w; gx++) {
      const c = cellAt(def, gx, gy);
      if (c === CellType.Wall) {
        items.push({ key: (gx + 1 + gy + 1) * CELL, draw: () => drawCube(ctx, gx, gy, WALL_Z, PAL.wallTop, PAL.wallL, PAL.wallR) });
      } else if (c === CellType.Post) {
        const px = (gx + 0.5) * CELL, py = (gy + 0.5) * CELL;
        items.push({ key: px + py, draw: () => drawPrism(ctx, px, py, POST_R, 0, WALL_Z + 2, PAL.postTop, PAL.postSide, PAL.postSide) });
      }
    }
  }
  // Windmill bars: a row of mini voxel cubes sweeping around the pivot.
  for (const bar of def.bars) {
    const w = barEndpoints(bar, g.holeClock);
    const segs = 5;
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      const x = w.x1 + (w.x2 - w.x1) * t;
      const y = w.y1 + (w.y2 - w.y1) * t;
      items.push({ key: x + y, draw: () => drawPrism(ctx, x, y, 9, 2, 12, '#d77b45', '#a3522a', '#7e3d1d') });
    }
  }
  // Flag at the cup.
  items.push({ key: def.cup.x + def.cup.y, draw: () => drawFlag(ctx, def, tSec) });
  // Ball.
  if (state.phase !== 'sunk') {
    items.push({ key: state.pos.x + state.pos.y, draw: () => drawBall(ctx, state.pos) });
  }
  // Golfer — hidden the moment the ball is struck; back when it rests.
  if (state.phase === 'resting' && (g.phase === 'play' || g.phase === 'intro')) {
    const stand = { x: state.pos.x - g.facing.x * 26, y: state.pos.y - g.facing.y * 26 };
    items.push({ key: stand.x + stand.y, draw: () => drawGolfer(ctx, stand, look, tSec, g.aiming) });
  }
  items.sort((a, b) => a.key - b.key);
  for (const it of items) it.draw();

  // ── Effects (screen-space, on top) ──
  if (g.splash > 0) drawSplash(ctx, state.preShot, g.splash);
  if (state.phase === 'resting' && g.aiming) drawAim(ctx, g);
}

function drawGroundCell(ctx: CanvasRenderingContext2D, def: HoleDef, gx: number, gy: number, tSec: number) {
  const c = cellAt(def, gx, gy);
  if (c === CellType.Void || c === CellType.Wall) return; // walls drawn as cubes
  const corners = cellCorners(gx, gy, 0);

  let fill: string;
  switch (c) {
    case CellType.Sand: fill = PAL.sand; break;
    case CellType.Water: fill = PAL.water; break;
    case CellType.SlopeN: case CellType.SlopeS: case CellType.SlopeE: case CellType.SlopeW:
      fill = PAL.slope; break;
    default: fill = (gx + gy) % 2 === 0 ? PAL.grassA : PAL.grassB;
  }
  poly(ctx, corners, fill);

  // Sharp baked shadows: light from the NW casts onto cells whose N or W
  // neighbour is a wall cube.
  const center = iso((gx + 0.5) * CELL, (gy + 0.5) * CELL, 0);
  if (cellAt(def, gx, gy - 1) === CellType.Wall) {
    poly(ctx, [corners[0], corners[1], center], PAL.shadow);
  }
  if (cellAt(def, gx - 1, gy) === CellType.Wall) {
    poly(ctx, [corners[0], corners[3], center], PAL.shadow);
  }

  // Per-type detail.
  if (c === CellType.Sand) {
    ctx.fillStyle = PAL.sandDot;
    for (let i = 0; i < 3; i++) {
      const dx = ((gx * 7 + gy * 13 + i * 11) % 10) / 10;
      const dy = ((gx * 17 + gy * 5 + i * 7) % 10) / 10;
      const p = iso((gx + 0.2 + dx * 0.6) * CELL, (gy + 0.2 + dy * 0.6) * CELL, 0);
      ctx.fillRect(p.x, p.y, 2.4, 1.4);
    }
  } else if (c === CellType.Water) {
    // Animated highlight stripe.
    const shift = (Math.sin(tSec * 1.6 + gx * 0.9 + gy * 0.7) + 1) / 2;
    const p1 = iso((gx + 0.15 + shift * 0.2) * CELL, (gy + 0.5) * CELL, 0);
    const p2 = iso((gx + 0.55 + shift * 0.2) * CELL, (gy + 0.5) * CELL, 0);
    ctx.strokeStyle = PAL.waterHi;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  } else if (c >= CellType.SlopeN && c <= CellType.SlopeW) {
    // Chevron pointing downhill (the acceleration direction).
    const dir = c === CellType.SlopeN ? { x: 0, y: -1 } : c === CellType.SlopeS ? { x: 0, y: 1 }
      : c === CellType.SlopeE ? { x: 1, y: 0 } : { x: -1, y: 0 };
    const cx = (gx + 0.5) * CELL, cy = (gy + 0.5) * CELL;
    const tip = iso(cx + dir.x * 11, cy + dir.y * 11, 0);
    const l = iso(cx - dir.x * 5 - dir.y * 8, cy - dir.y * 5 + dir.x * 8, 0);
    const r = iso(cx - dir.x * 5 + dir.y * 8, cy - dir.y * 5 - dir.x * 8, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(r.x, r.y); ctx.stroke();
  }
}

function drawCup(ctx: CanvasRenderingContext2D, def: HoleDef) {
  const p = iso(def.cup.x, def.cup.y, 0);
  ctx.fillStyle = '#f2efe6';
  ctx.beginPath(); ctx.ellipse(p.x, p.y, CUP_R * K * 1.7, CUP_R * K * 0.95, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0c0a08';
  ctx.beginPath(); ctx.ellipse(p.x, p.y, CUP_R * K * 1.45, CUP_R * K * 0.78, 0, 0, Math.PI * 2); ctx.fill();
}

function drawFlag(ctx: CanvasRenderingContext2D, def: HoleDef, tSec: number) {
  const base = iso(def.cup.x, def.cup.y, 0);
  const top = iso(def.cup.x, def.cup.y, 52);
  ctx.strokeStyle = '#e8e4dc';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
  const wave = Math.sin(tSec * 3) * 2;
  ctx.fillStyle = '#e8602c';
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(top.x + 24, top.y + 6 + wave);
  ctx.lineTo(top.x, top.y + 13);
  ctx.closePath();
  ctx.fill();
}

function drawBall(ctx: CanvasRenderingContext2D, pos: Vec) {
  const sh = iso(pos.x, pos.y, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(sh.x, sh.y, BALL_R, BALL_R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  const p = iso(pos.x, pos.y, BALL_R + 1);
  const grad = ctx.createRadialGradient(p.x - 2, p.y - 3, 1, p.x, p.y, BALL_R + 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#b9b4a8');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(p.x, p.y, BALL_R, 0, Math.PI * 2); ctx.fill();
}

function drawSplash(ctx: CanvasRenderingContext2D, at: Vec, t: number) {
  const p = iso(at.x, at.y, 0);
  ctx.strokeStyle = `rgba(150, 200, 255, ${t})`;
  ctx.lineWidth = 2;
  const r = (1 - t) * 26 + 6;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
}

function drawAim(ctx: CanvasRenderingContext2D, g: GameRef) {
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
    const p = iso(ball.x + dirX * d, ball.y + dirY * d, 2);
    const r = 3.2 - (i / dots) * 1.8;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Pull-back "rubber band" behind the ball.
  const pullLen = power * 60;
  const bp = iso(ball.x, ball.y, 2);
  const back = iso(ball.x - dirX * pullLen, ball.y - dirY * pullLen, 2);
  ctx.strokeStyle = 'rgba(232, 96, 44, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bp.x, bp.y); ctx.lineTo(back.x, back.y); ctx.stroke();
  // Power bar (screen space).
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(20, CANVAS_H - 26, 140, 10);
  ctx.fillStyle = power > 0.85 ? '#e2447e' : '#e8602c';
  ctx.fillRect(20, CANVAS_H - 26, 140 * power, 10);
}

/** Voxel mini-figure: stacked flat-shaded blocks, customizable palette. */
function drawGolfer(ctx: CanvasRenderingContext2D, stand: Vec, look: CharacterLook, tSec: number, aiming: boolean) {
  const skin = SKIN_COLORS[look.skin] ?? SKIN_COLORS[0];
  const hair = HAIR_COLORS[look.hair] ?? HAIR_COLORS[0];
  const outfit = OUTFIT_COLORS[look.outfit] ?? OUTFIT_COLORS[0];
  const pants = shade(outfit, -60);
  const outfitDark = shade(outfit, -28);

  const base = iso(stand.x, stand.y, 0);
  const bob = aiming ? 0 : Math.sin(tSec * 2.2) * 1.2;

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(base.x, base.y, 11, 4.5, 0, 0, Math.PI * 2); ctx.fill();

  const x = base.x, y0 = base.y + bob;
  // Legs (two voxel columns).
  ctx.fillStyle = pants;
  ctx.fillRect(x - 6, y0 - 14, 5, 14);
  ctx.fillRect(x + 1, y0 - 14, 5, 14);
  ctx.fillStyle = '#26211c';
  ctx.fillRect(x - 7, y0 - 2.6, 6.5, 3);
  ctx.fillRect(x + 0.5, y0 - 2.6, 6.5, 3);
  // Torso block: front face + a darker side sliver for the voxel read.
  ctx.fillStyle = outfit;
  ctx.fillRect(x - 8, y0 - 32, 14, 18);
  ctx.fillStyle = outfitDark;
  ctx.fillRect(x + 6, y0 - 32, 3, 18);
  // Arms + putter.
  ctx.strokeStyle = skin;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x - 6, y0 - 27); ctx.lineTo(x + 9, y0 - 18); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 5, y0 - 27); ctx.lineTo(x + 9, y0 - 18); ctx.stroke();
  ctx.strokeStyle = '#9b9b9b';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 9, y0 - 18); ctx.lineTo(x + 14, y0 - 1); ctx.stroke();
  ctx.fillStyle = '#6f6f6f';
  ctx.fillRect(x + 12, y0 - 2, 6, 3.4);
  // Head block + hair slab.
  ctx.fillStyle = skin;
  ctx.fillRect(x - 6, y0 - 45, 12, 12);
  ctx.fillStyle = shade(skin, -26);
  ctx.fillRect(x + 4, y0 - 45, 2, 12);
  ctx.fillStyle = hair;
  ctx.fillRect(x - 7, y0 - 48, 14, 5);
  ctx.fillRect(x - 7, y0 - 45, 3, 6);
}

function shade(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + delta));
  const gr = Math.max(0, Math.min(255, ((n >> 8) & 255) + delta));
  const b = Math.max(0, Math.min(255, (n & 255) + delta));
  return `#${((r << 16) | (gr << 8) | b).toString(16).padStart(6, '0')}`;
}
