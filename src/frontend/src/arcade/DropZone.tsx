import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon, LiveDot, formatPrincipal } from '../ui';

// ==========================================
// Drop Zone — arcade game 4: the PUBG/Warzone-style target drop.
//
// A plane crosses the 2 km map diagonally at 1 000 m. Press J to jump, steer
// the freefall (SHIFT dives — much faster fall, weaker steering, PUBG's
// ~126 vs ~234 km/h trade), SPACE deploys the chute (a slow sink with a long
// glide — deploy EARLY to cover distance, LATE to save time). Deploying
// under the 80 m safety floor is a crash: Warzone's "deploy higher than you
// think". Graded on distance to the target, tie-broken by jump→touchdown
// time; crashes never rank.
//
// Rendering: hand-rolled 3-D perspective on canvas 2D — black-ink-on-paper,
// boiling outlines (anime "line boil"), hatched shading, speed lines in a
// dive. Practice = random scenario each match, client-side. Daily = same
// day-seeded scenario for everyone (server-issued), stakers-only, once/day.
// ==========================================

// ── World / physics constants (meters, seconds) ──
export const MAP_M = 2_000;
export const PLANE_ALT = 1_000;
export const PLANE_SPEED = 110;
export const FALL_VY = 55;          // neutral freefall sink
export const DIVE_VY = 92;          // SHIFT dive sink
export const CHUTE_VY = 7;          // canopy sink
export const FALL_STEER = 30;       // max horizontal m/s, neutral fall
export const DIVE_STEER = 10;       // max horizontal m/s in a dive
export const CHUTE_STEER = 18;      // canopy glide m/s — the long-range tool
export const SAFE_DEPLOY_ALT = 80;  // below this the canopy can't open — crash
export const TARGET_RINGS_M = [5, 15, 40]; // bullseye rings (radius, meters)

export interface Scenario {
  targetX: number; // meters
  targetZ: number;
  planeDir: number; // 0..3 — entry corner of the diagonal
  decorSeed: number;
}

/** Deterministic PRNG (mulberry32) — scenery must match for a shared seed. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Practice scenario: random target in the central 60%, random diagonal. */
export function practiceScenario(rand: () => number = Math.random): Scenario {
  return {
    targetX: MAP_M * 0.2 + rand() * MAP_M * 0.6,
    targetZ: MAP_M * 0.2 + rand() * MAP_M * 0.6,
    planeDir: Math.floor(rand() * 4),
    decorSeed: Math.floor(rand() * 2 ** 31),
  };
}

/** Plane path for a diagonal code: start corner + unit heading. */
export function planePath(dir: number): { sx: number; sz: number; hx: number; hz: number } {
  const d = 0.70710678;
  switch (dir & 3) {
    case 0: return { sx: 0, sz: 0, hx: d, hz: d };          // NW → SE
    case 1: return { sx: MAP_M, sz: 0, hx: -d, hz: d };     // NE → SW
    case 2: return { sx: MAP_M, sz: MAP_M, hx: -d, hz: -d };// SE → NW
    default: return { sx: 0, sz: MAP_M, hx: d, hz: -d };    // SW → NE
  }
}

export interface Decor {
  trees: { x: number; z: number; h: number; r: number }[];
  houses: { x: number; z: number; w: number; d: number; h: number; rot: number }[];
  clouds: { x: number; z: number; y: number; s: number }[];
}

/** Scenery from a seed — kept clear of the target's inner 60 m. */
export function buildDecor(seed: number, targetX: number, targetZ: number): Decor {
  const rand = mulberry(seed);
  const clear = (x: number, z: number) => Math.hypot(x - targetX, z - targetZ) > 60;
  const trees: Decor['trees'] = [];
  while (trees.length < 70) {
    const x = rand() * MAP_M, z = rand() * MAP_M;
    if (clear(x, z)) trees.push({ x, z, h: 9 + rand() * 8, r: 4 + rand() * 4 });
  }
  const houses: Decor['houses'] = [];
  while (houses.length < 16) {
    const x = MAP_M * 0.1 + rand() * MAP_M * 0.8, z = MAP_M * 0.1 + rand() * MAP_M * 0.8;
    if (clear(x, z)) houses.push({ x, z, w: 12 + rand() * 10, d: 10 + rand() * 8, h: 6 + rand() * 4, rot: rand() * Math.PI });
  }
  const clouds: Decor['clouds'] = [];
  for (let i = 0; i < 12; i++) {
    clouds.push({ x: rand() * MAP_M, z: rand() * MAP_M, y: 350 + rand() * 400, s: 40 + rand() * 70 });
  }
  return { trees, houses, clouds };
}

// ── Physics ──
export interface FallState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  chuteAt: number | null; // altitude at deploy, null = not deployed
}

export interface FallInput { ax: number; az: number; dive: boolean } // ax/az ∈ [-1,1], world axes

/** One integration step. Returns the state mutated in place (for the loop)
 *  — pure enough to unit-test: no globals, no time source. */
export function stepFall(s: FallState, inp: FallInput, dt: number): FallState {
  const chute = s.chuteAt !== null;
  const sinkTarget = chute ? CHUTE_VY : inp.dive ? DIVE_VY : FALL_VY;
  s.vy += (sinkTarget - s.vy) * Math.min(1, dt * (chute ? 2.2 : 1.6));
  const steerMax = chute ? CHUTE_STEER : inp.dive ? DIVE_STEER : FALL_STEER;
  const accel = chute ? 22 : 26;
  s.vx += inp.ax * accel * dt;
  s.vz += inp.az * accel * dt;
  // Air drag pulls horizontal speed toward the regime's cap. The decay floor
  // keeps regime changes smooth (~0.3 s half-life) but must out-pull the
  // steering accel near every cap, or a dive would cruise above DIVE_STEER.
  const hv = Math.hypot(s.vx, s.vz);
  if (hv > steerMax) {
    const k = Math.max(steerMax / hv, 1 - dt * 3.5);
    s.vx *= k; s.vz *= k;
  }
  s.x += s.vx * dt;
  s.z += s.vz * dt;
  s.y -= s.vy * dt;
  s.x = Math.max(0, Math.min(MAP_M, s.x));
  s.z = Math.max(0, Math.min(MAP_M, s.z));
  return s;
}

/** Landing verdict: safe needs a canopy opened at/above the floor. */
export function landingVerdict(chuteAt: number | null): boolean {
  return chuteAt !== null && chuteAt >= SAFE_DEPLOY_ALT;
}

export function distanceToTarget(x: number, z: number, sc: Scenario): number {
  return Math.hypot(x - sc.targetX, z - sc.targetZ);
}

/** Friendly copy for daily error codes (mirrors Luck-Proof's). */
export function friendlyDropErr(code: string): string {
  switch (code) {
    case 'NOT_STAKED': return 'The daily drop is for no-loss-lottery stakers — stake any amount of ICP to enter.';
    case 'ALREADY_PLAYED_TODAY': return 'You\'ve used today\'s jump — a fresh drop zone opens at 00:00 UTC.';
    case 'RUN_EXPIRED': return 'This run timed out (15-minute limit). Today\'s attempt was consumed.';
    default: return code;
  }
}

// ── Ink helpers (the hand-drawn look) ──
/** Deterministic per-vertex jitter, re-rolled ~5×/s: the anime "line boil". */
function boil(id: number, tick: number): number {
  const n = Math.sin(id * 127.1 + tick * 311.7) * 43758.5453;
  return (n - Math.floor(n) - 0.5) * 2.6;
}

interface Cam { x: number; y: number; z: number; yaw: number; pitch: number; f: number; w: number; h: number }

function project(cam: Cam, wx: number, wy: number, wz: number): { sx: number; sy: number; d: number } | null {
  let dx = wx - cam.x, dy = wy - cam.y, dz = wz - cam.z;
  const cy = Math.cos(cam.yaw), sy_ = Math.sin(cam.yaw);
  const rx = dx * cy - dz * sy_;
  const rz = dx * sy_ + dz * cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const ry2 = dy * cp - rz * sp;
  const rz2 = dy * sp + rz * cp;
  if (rz2 < 2) return null;
  return { sx: cam.w / 2 + (cam.f * rx) / rz2, sy: cam.h / 2 - (cam.f * ry2) / rz2, d: rz2 };
}

type Mode = 'menu' | 'play' | 'done';
type Phase = 'plane' | 'fall' | 'landed';

interface DailyStatus { day: number; eligible: boolean; played: boolean; my_entry?: any; players_today: number }
interface DailyRow { rank: number; player: any; distance_dm: number; millis: bigint; safe: boolean }

interface DropZoneProps {
  actor: any;
  onGoParticipate: () => void;
}

export default function DropZone({ actor, onGoParticipate }: DropZoneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [board, setBoard] = useState<DailyRow[]>([]);
  const [result, setResult] = useState<{ dist: number; ms: number; safe: boolean; daily: boolean; rank: number | null } | null>(null);

  // All live game state in a ref — the RAF loop owns it.
  const g = useRef<{
    scenario: Scenario; decor: Decor; phase: Phase;
    planeT: number; fall: FallState; jumpAt: number; endAt: number;
    daily: boolean; runId: bigint | null;
    keys: Record<string, boolean>; touch: { ax: number; az: number };
    t: number;
  } | null>(null);

  const refreshMenu = async () => {
    try {
      const [st, rows] = await Promise.all([
        actor.get_skydive_daily_status(),
        actor.get_skydive_daily_board(null),
      ]);
      setStatus(st); setBoard(rows);
    } catch { /* best-effort */ }
  };
  useEffect(() => { refreshMenu(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor]);

  const launch = (scenario: Scenario, daily: boolean, runId: bigint | null) => {
    g.current = {
      scenario,
      decor: buildDecor(scenario.decorSeed, scenario.targetX, scenario.targetZ),
      phase: 'plane', planeT: 0,
      fall: { x: 0, y: PLANE_ALT, z: 0, vx: 0, vy: 0, vz: 0, chuteAt: null },
      jumpAt: 0, endAt: 0, daily, runId,
      keys: {}, touch: { ax: 0, az: 0 }, t: 0,
    };
    setResult(null); setErr(null);
    setMode('play');
  };

  const startPractice = () => launch(practiceScenario(), false, null);

  const startDaily = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await actor.start_skydive_daily();
      if (res.__kind__ === 'Err') throw new Error(friendlyDropErr(res.Err));
      const sc = res.Ok.scenario;
      launch(
        { targetX: sc.target_x_dm / 10, targetZ: sc.target_z_dm / 10, planeDir: sc.plane_dir, decorSeed: Number(sc.decor_seed % 2_147_483_647n) },
        true, res.Ok.run_id,
      );
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const submitDaily = async (dist: number, ms: number, safe: boolean) => {
    const game = g.current;
    if (!game?.runId) return null;
    try {
      const res = await actor.complete_skydive_daily(game.runId, Math.round(dist * 10), BigInt(Math.max(3_001, Math.round(ms))), safe);
      if (res.__kind__ === 'Err') throw new Error(friendlyDropErr(res.Err));
      return res.Ok as number;
    } catch (e: any) {
      setErr(e?.message || String(e));
      return null;
    }
  };

  // ── Input ──
  useEffect(() => {
    if (mode !== 'play') return;
    const down = (e: KeyboardEvent) => {
      const game = g.current;
      if (!game) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase()) || e.key === ' ') e.preventDefault();
      game.keys[k] = true;
      if (k === 'j' && game.phase === 'plane') jump();
      if (k === ' ' && game.phase === 'fall' && game.fall.chuteAt === null) deploy();
    };
    const up = (e: KeyboardEvent) => { if (g.current) g.current.keys[e.key.toLowerCase()] = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const jump = () => {
    const game = g.current;
    if (!game || game.phase !== 'plane') return;
    const path = planePath(game.scenario.planeDir);
    const d = game.planeT * PLANE_SPEED;
    game.fall = {
      x: path.sx + path.hx * d, y: PLANE_ALT, z: path.sz + path.hz * d,
      vx: path.hx * PLANE_SPEED * 0.35, vy: 0, vz: path.hz * PLANE_SPEED * 0.35,
      chuteAt: null,
    };
    game.jumpAt = game.t;
    game.phase = 'fall';
  };

  const deploy = () => {
    const game = g.current;
    if (!game || game.phase !== 'fall' || game.fall.chuteAt !== null) return;
    game.fall.chuteAt = game.fall.y;
  };

  // ── The loop ──
  useEffect(() => {
    if (mode !== 'play') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    let landedHandled = false;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const game = g.current;
      if (!game) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      game.t += dt;

      // ── Advance ──
      if (game.phase === 'plane') {
        game.planeT += dt;
        const path = planePath(game.scenario.planeDir);
        const d = game.planeT * PLANE_SPEED;
        if (d >= MAP_M * 1.41421356) jump(); // end of the diagonal — auto-eject
        game.fall.x = path.sx + path.hx * d;
        game.fall.z = path.sz + path.hz * d;
        game.fall.y = PLANE_ALT;
      } else if (game.phase === 'fall') {
        const k = game.keys;
        const path = planePath(game.scenario.planeDir);
        // Screen-relative steering rotated onto world axes (camera yaw = heading).
        const fwd = (k['arrowup'] || k['w'] ? 1 : 0) - (k['arrowdown'] || k['s'] ? 1 : 0);
        const side = (k['arrowright'] || k['d'] ? 1 : 0) - (k['arrowleft'] || k['a'] ? 1 : 0);
        const ax = path.hx * fwd + -path.hz * side + game.touch.ax;
        const az = path.hz * fwd + path.hx * side + game.touch.az;
        const n = Math.hypot(ax, az) || 1;
        stepFall(game.fall, { ax: ax / Math.max(1, n), az: az / Math.max(1, n), dive: !!(k['shift']) }, dt);
        if (game.fall.y <= 0) {
          game.fall.y = 0;
          game.phase = 'landed';
          game.endAt = game.t;
        }
      } else if (game.phase === 'landed' && !landedHandled) {
        landedHandled = true;
        const dist = distanceToTarget(game.fall.x, game.fall.z, game.scenario);
        const ms = (game.endAt - game.jumpAt) * 1000;
        const safe = landingVerdict(game.fall.chuteAt);
        (async () => {
          const rank = game.daily ? await submitDaily(dist, ms, safe) : null;
          setResult({ dist, ms, safe, daily: game.daily, rank });
          setMode('done');
          refreshMenu();
        })();
      }

      draw(ctx, canvas.width, canvas.height, game);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Renderer ──
  const draw = (ctx: CanvasRenderingContext2D, W: number, H: number, game: NonNullable<typeof g.current>) => {
    const tick = Math.floor(game.t * 5); // line-boil clock
    ctx.fillStyle = '#f6f4ef'; // paper
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#141414';
    ctx.lineCap = 'round';

    const path = planePath(game.scenario.planeDir);
    const yaw = Math.atan2(path.hx, path.hz);
    const inPlane = game.phase === 'plane';
    const p = game.fall;
    // Chase camera: above + behind, pitched down harder as you fall.
    const pitch = inPlane ? 0.55 : Math.min(1.15, 0.55 + (1 - p.y / PLANE_ALT) * 0.35);
    const back = inPlane ? 90 : 60;
    const cam: Cam = {
      x: p.x - path.hx * back, y: p.y + (inPlane ? 40 : 55), z: p.z - path.hz * back,
      yaw, pitch, f: H * 0.9, w: W, h: H,
    };

    // Horizon wash + ground edge.
    const horizon = project(cam, p.x + path.hx * 4000, 0, p.z + path.hz * 4000);
    if (horizon) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, Math.max(0, horizon.sy));
      ctx.fillStyle = '#f6f4ef';
      ctx.fillRect(0, Math.max(0, horizon.sy), W, H);
      ctx.strokeStyle = '#141414'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0, horizon.sy); ctx.lineTo(W, horizon.sy); ctx.stroke();
    }

    // Painter's queue for world objects.
    const q: { d: number; draw: () => void }[] = [];

    // Ground hatching patches (sparse fields).
    const fr = mulberry(game.scenario.decorSeed ^ 0x5eed);
    for (let i = 0; i < 14; i++) {
      const fx = fr() * MAP_M, fz = fr() * MAP_M, fs = 90 + fr() * 160, ang = fr() * Math.PI;
      const c = project(cam, fx, 0, fz);
      if (!c) continue;
      q.push({ d: c.d, draw: () => {
        ctx.save(); ctx.globalAlpha = 0.35; ctx.lineWidth = 0.8;
        for (let l = -3; l <= 3; l++) {
          const ox = Math.cos(ang) * l * fs * 0.14, oz = Math.sin(ang) * l * fs * 0.14;
          const a = project(cam, fx + ox - Math.sin(ang) * fs / 2, 0, fz + oz + Math.cos(ang) * fs / 2);
          const b = project(cam, fx + ox + Math.sin(ang) * fs / 2, 0, fz + oz - Math.cos(ang) * fs / 2);
          if (a && b) { ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke(); }
        }
        ctx.restore();
      }});
    }

    // Target rings + flag.
    {
      const sc = game.scenario;
      const c = project(cam, sc.targetX, 0, sc.targetZ);
      if (c) q.push({ d: c.d, draw: () => {
        TARGET_RINGS_M.forEach((r, ri) => {
          ctx.beginPath();
          for (let a = 0; a <= 32; a++) {
            const th = (a / 32) * Math.PI * 2;
            const pt = project(cam, sc.targetX + Math.cos(th) * r, 0, sc.targetZ + Math.sin(th) * r);
            if (pt) { const j = boil(ri * 40 + a, tick); a === 0 ? ctx.moveTo(pt.sx + j, pt.sy) : ctx.lineTo(pt.sx + j, pt.sy); }
          }
          ctx.lineWidth = ri === 0 ? 2.4 : 1.4;
          ctx.stroke();
        });
        const top = project(cam, sc.targetX, 14, sc.targetZ);
        if (top) {
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
          ctx.fillStyle = '#141414';
          ctx.beginPath(); ctx.moveTo(top.sx, top.sy); ctx.lineTo(top.sx + 18, top.sy + 5); ctx.lineTo(top.sx, top.sy + 10); ctx.closePath(); ctx.fill();
        }
      }});
    }

    // Trees: trunk + scribbled canopy.
    game.decor.trees.forEach((t, i) => {
      const base = project(cam, t.x, 0, t.z);
      if (!base || base.d > 1600) return;
      q.push({ d: base.d, draw: () => {
        const top = project(cam, t.x, t.h, t.z);
        if (!top) return;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(base.sx, base.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
        const rr = (cam.f * t.r) / base.d;
        ctx.beginPath();
        for (let a = 0; a <= 14; a++) {
          const th = (a / 14) * Math.PI * 2;
          const j = boil(i * 17 + a, tick);
          const px = top.sx + Math.cos(th) * (rr + j), py = top.sy + Math.sin(th) * (rr * 0.8 + j);
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 1.4; ctx.stroke();
      }});
    });

    // Houses: hatched-roof ink boxes.
    game.decor.houses.forEach((hs, i) => {
      const base = project(cam, hs.x, 0, hs.z);
      if (!base || base.d > 1600) return;
      q.push({ d: base.d, draw: () => {
        const cs = Math.cos(hs.rot), sn = Math.sin(hs.rot);
        const cnr = (dx: number, dz: number, y: number) =>
          project(cam, hs.x + dx * cs - dz * sn, y, hs.z + dx * sn + dz * cs);
        const w2 = hs.w / 2, d2 = hs.d / 2;
        const pts = [cnr(-w2, -d2, 0), cnr(w2, -d2, 0), cnr(w2, d2, 0), cnr(-w2, d2, 0),
                     cnr(-w2, -d2, hs.h), cnr(w2, -d2, hs.h), cnr(w2, d2, hs.h), cnr(-w2, d2, hs.h),
                     cnr(0, -d2, hs.h + 4), cnr(0, d2, hs.h + 4)];
        if (pts.some((pt) => !pt)) return;
        const P = pts as NonNullable<(typeof pts)[0]>[];
        ctx.fillStyle = '#ffffff'; ctx.lineWidth = 1.5;
        const poly = (ids: number[], hatch = false) => {
          ctx.beginPath();
          ids.forEach((id, k) => {
            const j = boil(i * 31 + id, tick);
            k === 0 ? ctx.moveTo(P[id].sx + j, P[id].sy) : ctx.lineTo(P[id].sx + j, P[id].sy);
          });
          ctx.closePath(); ctx.fill(); ctx.stroke();
          if (hatch) {
            ctx.save(); ctx.clip(); ctx.lineWidth = 0.7; ctx.globalAlpha = 0.5;
            const minx = Math.min(...ids.map((id) => P[id].sx)), maxx = Math.max(...ids.map((id) => P[id].sx));
            const miny = Math.min(...ids.map((id) => P[id].sy)), maxy = Math.max(...ids.map((id) => P[id].sy));
            for (let x = minx - (maxy - miny); x < maxx; x += 5) {
              ctx.beginPath(); ctx.moveTo(x, miny); ctx.lineTo(x + (maxy - miny), maxy); ctx.stroke();
            }
            ctx.restore();
          }
        };
        poly([0, 1, 5, 4]); poly([1, 2, 6, 5]); // walls
        poly([4, 5, 8], true); poly([5, 6, 9, 8], true); // roof
      }});
    });

    // Clouds: bumpy ink billboards (only from above or near altitude).
    game.decor.clouds.forEach((cl, i) => {
      const c = project(cam, cl.x, cl.y, cl.z);
      if (!c) return;
      q.push({ d: c.d, draw: () => {
        const r = (cam.f * cl.s) / c.d;
        if (r < 3) return;
        ctx.beginPath();
        for (let a = 0; a <= 16; a++) {
          const th = (a / 16) * Math.PI * 2;
          const bump = 1 + 0.24 * Math.sin(a * 2.7 + i);
          const j = boil(i * 23 + a, tick);
          const px = c.sx + Math.cos(th) * (r * bump + j), py = c.sy + Math.sin(th) * (r * 0.45 * bump + j);
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 1.3; ctx.stroke();
      }});
    });

    q.sort((a, b) => b.d - a.d).forEach((o) => o.draw());

    // ── The plane (during approach) & the jumper ──
    if (inPlane) {
      const c = project(cam, p.x, PLANE_ALT, p.z)!;
      ctx.lineWidth = 2.2; ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(c.sx, c.sy, 34, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c.sx - 6, c.sy); ctx.lineTo(c.sx - 26, c.sy - 14); ctx.lineTo(c.sx - 12, c.sy); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c.sx + 28, c.sy - 2); ctx.lineTo(c.sx + 38, c.sy - 12); ctx.lineTo(c.sx + 30, c.sy - 2); ctx.stroke();
    } else {
      const c = project(cam, p.x, p.y, p.z);
      if (c) {
        ctx.lineWidth = 2;
        const chute = p.chuteAt !== null;
        if (chute) {
          ctx.beginPath(); ctx.arc(c.sx, c.sy - 26, 20, Math.PI, 0); ctx.closePath();
          ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(c.sx - 18, c.sy - 24); ctx.lineTo(c.sx, c.sy - 4);
          ctx.moveTo(c.sx + 18, c.sy - 24); ctx.lineTo(c.sx, c.sy - 4); ctx.stroke();
        }
        // Jumper: head + spread limbs (tucked in a dive).
        const dive = game.keys['shift'] && !chute;
        ctx.beginPath(); ctx.arc(c.sx, c.sy - (chute ? 0 : 4), 3.4, 0, Math.PI * 2); ctx.fillStyle = '#141414'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(c.sx, c.sy); ctx.lineTo(c.sx, c.sy + 9);
        const spread = dive ? 3 : 8;
        ctx.moveTo(c.sx - spread, c.sy + (dive ? 12 : 3)); ctx.lineTo(c.sx, c.sy + 4); ctx.lineTo(c.sx + spread, c.sy + (dive ? 12 : 3));
        ctx.moveTo(c.sx - spread, c.sy + 15); ctx.lineTo(c.sx, c.sy + 9); ctx.lineTo(c.sx + spread, c.sy + 15);
        ctx.stroke();
        // Dive speed lines — the anime touch.
        if (dive) {
          ctx.save(); ctx.globalAlpha = 0.5; ctx.lineWidth = 1.2;
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2 + boil(i, tick) * 0.2;
            const r1 = Math.min(W, H) * 0.42, r2 = r1 + 26 + boil(i + 50, tick) * 6;
            ctx.beginPath();
            ctx.moveTo(W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1);
            ctx.lineTo(W / 2 + Math.cos(a) * r2, H / 2 + Math.sin(a) * r2);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    // ── HUD ──
    ctx.fillStyle = '#141414';
    ctx.font = '600 13px ui-monospace, monospace';
    const dist = distanceToTarget(p.x, p.z, game.scenario);
    if (inPlane) {
      ctx.textAlign = 'center';
      const pulse = 0.6 + 0.4 * Math.sin(game.t * 5);
      ctx.globalAlpha = pulse;
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.fillText('press J to JUMP', W / 2, H * 0.2);
      ctx.globalAlpha = 1;
      ctx.font = '600 13px ui-monospace, monospace';
      ctx.fillText(`target ${Math.round(dist)} m ${dist < 320 ? '— NOW!' : ''}`, W / 2, H * 0.2 + 22);
      ctx.textAlign = 'left';
    } else {
      ctx.fillText(`ALT ${Math.max(0, Math.round(p.y))} m`, 12, 22);
      ctx.fillText(`SINK ${Math.round(p.vy)} m/s`, 12, 40);
      ctx.fillText(`TARGET ${Math.round(dist)} m`, 12, 58);
      ctx.fillText(`T ${((game.t - game.jumpAt)).toFixed(1)} s`, 12, 76);
      // Altimeter with the 80 m floor marked.
      const ax = W - 26, ah = H * 0.6, ay = H * 0.2;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(ax, ay, 10, ah);
      const floorY = ay + ah * (1 - SAFE_DEPLOY_ALT / PLANE_ALT);
      ctx.beginPath(); ctx.moveTo(ax - 4, floorY); ctx.lineTo(ax + 14, floorY); ctx.stroke();
      ctx.fillRect(ax, ay + ah * (1 - Math.max(0, p.y) / PLANE_ALT) - 2, 10, 4);
      if (p.chuteAt === null && p.y < SAFE_DEPLOY_ALT * 2.2 && game.phase === 'fall') {
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.65 + 0.35 * Math.sin(game.t * 9);
        ctx.font = '700 20px ui-monospace, monospace';
        ctx.fillText(p.y >= SAFE_DEPLOY_ALT ? 'SPACE — DEPLOY!' : 'TOO LOW…', W / 2, H * 0.16);
        ctx.globalAlpha = 1;
        ctx.textAlign = 'left';
        ctx.font = '600 13px ui-monospace, monospace';
      }
    }

    // ── Minimap ──
    const ms = Math.min(130, W * 0.24), mx = W - ms - 12, my = 12;
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.88;
    ctx.fillRect(mx, my, ms, ms); ctx.globalAlpha = 1;
    ctx.lineWidth = 1.6; ctx.strokeRect(mx, my, ms, ms);
    const mm = (wx: number, wz: number) => ({ x: mx + (wx / MAP_M) * ms, y: my + (wz / MAP_M) * ms });
    const tg = mm(game.scenario.targetX, game.scenario.targetZ);
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(tg.x - 5, tg.y - 5); ctx.lineTo(tg.x + 5, tg.y + 5); ctx.moveTo(tg.x + 5, tg.y - 5); ctx.lineTo(tg.x - 5, tg.y + 5); ctx.stroke();
    const me = mm(p.x, p.z);
    ctx.fillStyle = '#141414';
    if (inPlane) {
      ctx.save(); ctx.translate(me.x, me.y); ctx.rotate(Math.atan2(path.hz, path.hx));
      ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-5, -4); ctx.lineTo(-5, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(me.x, me.y, 3.4, 0, Math.PI * 2); ctx.fill();
    }
  };

  // Touch steering: drag anywhere on the canvas.
  const touchRef = useRef<{ id: number; sx: number; sy: number } | null>(null);
  const onTouchMove = (e: React.TouchEvent) => {
    const game = g.current;
    if (!game || game.phase !== 'fall') return;
    const t = e.touches[0];
    if (!touchRef.current) { touchRef.current = { id: t.identifier, sx: t.clientX, sy: t.clientY }; return; }
    const path = planePath(game.scenario.planeDir);
    const side = Math.max(-1, Math.min(1, (t.clientX - touchRef.current.sx) / 70));
    const fwd = Math.max(-1, Math.min(1, (touchRef.current.sy - t.clientY) / 70));
    game.touch.ax = path.hx * fwd + -path.hz * side;
    game.touch.az = path.hz * fwd + path.hx * side;
  };
  const onTouchEnd = () => { touchRef.current = null; if (g.current) g.current.touch = { ax: 0, az: 0 }; };

  const fmtM = (m: number) => m < 100 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;

  return (
    <div className="col" style={{ gap: 12, maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', borderBottom: '2px solid var(--border)', paddingBottom: 10 }}>
        <b style={{ fontSize: 14, letterSpacing: '0.04em' }}>
          DROP ZONE <span style={{ color: 'var(--fg-3)' }}>// {mode === 'play' ? (g.current?.daily ? 'DAILY DROP' : 'PRACTICE') : 'ARCADE'}</span>
        </b>
        {mode !== 'menu' && (
          <Btn variant="ghost" sm onClick={() => { setMode('menu'); g.current = null; refreshMenu(); }}>
            <Icon name="x" size={12} /> Quit
          </Btn>
        )}
      </div>

      {mode === 'menu' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 10 }}>
              <Chip tone="muted" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>Practice</Chip>
              <b style={{ fontSize: 15 }}>Free jumps</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                A fresh target every drop, nothing recorded. <span className="mono">J</span> jumps
                when the plane's close, arrows steer, <span className="mono">SHIFT</span> dives
                (fast fall, weak steering), <span className="mono">SPACE</span> pops the chute —
                above <b>80 m</b> or you crater. Early chute = long glide; late chute = fast time.
              </p>
              <Btn variant="secondary" onClick={startPractice}><Icon name="parachute" size={13} /> Jump</Btn>
            </div>
            <div className="card col" style={{ gap: 10, borderColor: 'var(--burn)' }}>
              <Chip tone="burn" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>
                <LiveDot color="var(--burn-ink)" size={5} /> Daily drop
              </Chip>
              <b style={{ fontSize: 15 }}>One jump · same sky for everyone</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Everyone gets today's exact scenario — same plane, same target, same
                terrain. Closest to the bullseye wins; ties go to the faster jump.
                Land without a proper canopy and the attempt is gone. <b>One attempt —
                no restarts.</b> Resets 00:00 UTC.
              </p>
              {status && !status.eligible ? (
                <div className="col" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--haze-ink)' }}>
                    <Icon name="lock" size={13} stroke="var(--haze-ink)" /> The daily drop is for no-loss-lottery stakers.
                  </span>
                  <Btn variant="primary" onClick={onGoParticipate}><Icon name="zap" size={13} stroke="var(--char-950)" /> Stake ICP to enter</Btn>
                </div>
              ) : status?.played ? (
                <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                  <Icon name="checkCircle" size={11} /> Jumped today{status.my_entry ? ` — ${(status.my_entry.distance_dm / 10).toFixed(1)} m ${status.my_entry.safe ? '' : '· crashed'}` : ''}
                </Chip>
              ) : (
                <Btn variant="primary" disabled={busy || !status} onClick={startDaily}>
                  {busy ? <LiveDot size={8} /> : <Icon name="parachute" size={13} stroke="var(--char-950)" />} Board the plane
                </Btn>
              )}
            </div>
          </div>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}

          <div className="card col" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <b style={{ fontSize: 13.5 }}>Today's board</b>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>distance · time · {status?.players_today ?? 0} jumped</span>
            </span>
            {board.length === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Empty sky so far — first jumper sets the mark.</span>
            ) : (
              <div className="col" style={{ gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                {board.map((r) => (
                  <span key={r.rank} className="row mono" style={{ gap: 8, fontSize: 12, justifyContent: 'space-between', padding: '5px 4px', borderBottom: '1px solid var(--border)', opacity: r.safe ? 1 : 0.55 }}>
                    <span>#{r.rank} {formatPrincipal(r.player)}</span>
                    <span>{r.safe ? `${(r.distance_dm / 10).toFixed(1)} m · ${(Number(r.millis) / 1000).toFixed(1)} s` : 'crashed ✗'}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {mode === 'play' && (
        <div className="col" style={{ gap: 8 }}>
          <canvas
            ref={canvasRef}
            width={720}
            height={460}
            onTouchStart={onTouchMove}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            style={{ width: '100%', height: 'auto', borderRadius: 10, border: '1px solid var(--border-hi)', touchAction: 'none', background: '#f6f4ef' }}
          />
          <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Btn variant="primary" sm onClick={jump} style={{ minWidth: 110, minHeight: 44 }}>J · JUMP</Btn>
            <span
              onPointerDown={() => { if (g.current) g.current.keys['shift'] = true; }}
              onPointerUp={() => { if (g.current) g.current.keys['shift'] = false; }}
              onPointerLeave={() => { if (g.current) g.current.keys['shift'] = false; }}
              style={{ display: 'inline-flex' }}
            >
              <Btn variant="secondary" sm style={{ minWidth: 110, minHeight: 44 }}>SHIFT · DIVE</Btn>
            </span>
            <Btn variant="primary" sm onClick={deploy} style={{ minWidth: 110, minHeight: 44 }}>SPACE · CHUTE</Btn>
          </div>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textAlign: 'center' }}>
            arrows steer (touch: drag) · deploy above 80 m to land safely
          </span>
        </div>
      )}

      {mode === 'done' && result && (
        <div className="card col" style={{ gap: 12 }}>
          <h3 style={{ margin: 0 }}>
            {!result.safe ? 'Crashed — the canopy never opened.'
              : result.dist <= TARGET_RINGS_M[0] ? `BULLSEYE — ${fmtM(result.dist)} out.`
              : `Landed ${fmtM(result.dist)} from the target.`}
          </h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Chip tone={result.safe ? 'ok' : 'muted'}>
              <span className="mono">{result.safe ? 'safe landing' : 'unsafe'} · {(result.ms / 1000).toFixed(1)} s in the air</span>
            </Chip>
            {result.daily && result.rank !== null && (
              <Chip tone="burn"><span className="mono">rank #{result.rank} today</span></Chip>
            )}
          </div>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
          <div className="row" style={{ gap: 8 }}>
            {!result.daily && <Btn variant="primary" onClick={startPractice}><Icon name="parachute" size={13} stroke="var(--char-950)" /> Jump again</Btn>}
            <Btn variant="secondary" onClick={() => { setMode('menu'); g.current = null; refreshMenu(); }}>Back to the board</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
