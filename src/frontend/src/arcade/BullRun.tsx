import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon, LiveDot, formatPrincipal } from '../ui';
import { mulberry } from './DropZone';

// ==========================================
// Bull Run — arcade game 5: the encierro lane-runner.
//
// A lone black bull charges 1.5 km through Spanish streets to the bullring:
// three lanes, ←/→ to cut across, ↑/SPACE to jump the barriers (carts can't
// be jumped — dodge them), EXACTLY 120 coins laid along the course. Stumbles
// halve your speed, so the board's coins-then-time ranking already prices
// sloppy running. Same ink-outline look as Drop Zone, in Spanish-town color:
// whitewash and ochre walls, terracotta roofs, red-and-yellow bunting.
//
// PRACTICE runs a random street. The DAILY mirrors the other Play-to-Earn
// games: once per UTC day (local replays free), stakers-only, everyone runs
// the SAME day-seeded street; completion is bounds-validated server-side.
// ==========================================

// ── Course constants (meters) ──
export const COURSE_M = 1_500;
export const LANE_X = [-2.4, 0, 2.4];
export const STREET_HALF_W = 4.2;
export const COINS_TOTAL = 120; // mirrors the backend BULLRUN_COINS bound
export const BASE_SPEED = 13;
export const MAX_SPEED = 24;
export const ACCEL = 0.12;       // m/s per second of clean running
export const STUMBLE_FACTOR = 0.5;
export const JUMP_VY = 7.8;
export const GRAVITY = 20;
export const BARRIER_CLEAR = 0.8; // airborne above this clears a barrier

export type ObstacleKind = 'barrier' | 'barrels' | 'cart';

export interface Obstacle { z: number; lane: number; kind: ObstacleKind; hit?: boolean }
export interface Coin { z: number; lane: number; y: number; taken?: boolean }
export interface Building { z: number; side: -1 | 1; w: number; h: number; tone: number }

export interface Course {
  obstacles: Obstacle[];
  coins: Coin[];
  buildings: Building[];
  buntings: number[]; // z positions of flag strings across the street
}

/** The clearance height an airborne bull needs over each obstacle kind —
 *  carts are simply too tall to jump. */
export function obstacleClearY(kind: ObstacleKind): number {
  return kind === 'cart' ? 99 : BARRIER_CLEAR;
}

/** Build the whole street from a seed. ALWAYS exactly COINS_TOTAL coins and
 *  never a z-slot with all three lanes blocked. */
export function buildCourse(seed: number): Course {
  const rand = mulberry(seed >>> 0);
  const obstacles: Obstacle[] = [];
  let z = 70;
  while (z < COURSE_M - 80) {
    const lane = Math.floor(rand() * 3);
    const roll = rand();
    const kind: ObstacleKind = roll < 0.45 ? 'barrier' : roll < 0.75 ? 'barrels' : 'cart';
    obstacles.push({ z, lane, kind });
    // Occasionally block a second lane — but never the third.
    if (rand() < 0.3) {
      const lane2 = (lane + 1 + Math.floor(rand() * 2)) % 3;
      const roll2 = rand();
      obstacles.push({ z, lane: lane2, kind: roll2 < 0.6 ? 'barrier' : 'barrels' });
    }
    z += 20 + rand() * 26;
  }
  // Coins: 20 runs of 6. Half hug a lane on the ground; the rest arc as if
  // over a jump (collect them mid-air).
  const coins: Coin[] = [];
  for (let run = 0; run < 20; run++) {
    const rz = 50 + (run / 20) * (COURSE_M - 140) + rand() * 30;
    const lane = Math.floor(rand() * 3);
    const arc = rand() < 0.4;
    for (let i = 0; i < 6; i++) {
      const cz = rz + i * 4;
      const y = arc ? 0.6 + Math.sin((i / 5) * Math.PI) * 1.3 : 0.55;
      coins.push({ z: cz, lane, y });
    }
  }
  // Street walls: buildings marching down both sides.
  const buildings: Building[] = [];
  for (let side of [-1, 1] as const) {
    let bz = -20;
    while (bz < COURSE_M + 60) {
      const w = 12 + rand() * 10;
      buildings.push({ z: bz, side, w, h: 7 + rand() * 7, tone: rand() });
      bz += w + 1.5;
    }
  }
  const buntings: number[] = [];
  for (let bz = 100; bz < COURSE_M - 60; bz += 80 + rand() * 60) buntings.push(bz);
  return { obstacles, coins, buildings, buntings };
}

// ── Bull state & physics ──
export interface BullState {
  z: number;
  lane: number;   // target lane index
  x: number;      // smoothed world x
  y: number;      // height above ground
  vy: number;
  speed: number;
  coins: number;
  stumbles: number;
  invulnT: number; // seconds of post-stumble grace
  t: number;       // run clock, seconds
}

export function freshBull(): BullState {
  return { z: 0, lane: 1, x: 0, y: 0, vy: 0, speed: BASE_SPEED, coins: 0, stumbles: 0, invulnT: 0, t: 0 };
}

/** One physics step: advance, lerp into the lane, integrate the jump,
 *  collect coins, stumble on obstacles. Pure — mutates and returns `b`. */
export function stepBull(b: BullState, course: Course, dt: number): BullState {
  b.t += dt;
  // Clean running builds speed back up; ACCEL is per second of running.
  b.speed = Math.min(MAX_SPEED, b.speed + ACCEL * 10 * dt);
  b.z += b.speed * dt;
  b.x += (LANE_X[b.lane] - b.x) * Math.min(1, dt * 9);
  if (b.y > 0 || b.vy > 0) {
    b.vy -= GRAVITY * dt;
    b.y = Math.max(0, b.y + b.vy * dt);
    if (b.y === 0) b.vy = 0;
  }
  if (b.invulnT > 0) b.invulnT = Math.max(0, b.invulnT - dt);
  // Coins: same lane, close in z, and reachable in y.
  for (const c of course.coins) {
    if (c.taken || Math.abs(c.z - b.z) > 1.4) continue;
    if (LANE_X[c.lane] !== LANE_X[b.lane]) continue;
    if (Math.abs(c.y - (b.y + 0.5)) < 1.05) {
      c.taken = true;
      b.coins += 1;
    }
  }
  // Obstacles: stumble unless airborne above the clear height.
  if (b.invulnT === 0) {
    for (const o of course.obstacles) {
      if (o.hit || Math.abs(o.z - b.z) > 1.1 || o.lane !== b.lane) continue;
      if (b.y >= obstacleClearY(o.kind)) continue;
      o.hit = true;
      b.stumbles += 1;
      b.speed = Math.max(BASE_SPEED * 0.6, b.speed * STUMBLE_FACTOR);
      b.invulnT = 1.2;
    }
  }
  return b;
}

/** Friendly copy for daily error codes (mirrors the other dailies). */
export function friendlyBullErr(code: string): string {
  switch (code) {
    case 'NOT_STAKED': return 'The daily run is for no-loss-lottery stakers — stake any amount of ICP to enter.';
    case 'ALREADY_PLAYED_TODAY': return 'You\'ve run today\'s street — a fresh course opens at 00:00 UTC.';
    case 'RUN_EXPIRED': return 'This run timed out (15-minute limit). Today\'s attempt was consumed.';
    default: return code;
  }
}

// ── Projection (chase cam straight down the street) ──
interface Cam { x: number; y: number; z: number; pitch: number; f: number; w: number; h: number }
function project(cam: Cam, wx: number, wy: number, wz: number): { sx: number; sy: number; d: number } | null {
  const dx = wx - cam.x, dy = wy - cam.y, dz = wz - cam.z;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const ry = dy * cp + dz * sp;
  const rd = dz * cp - dy * sp;
  if (rd < 0.8) return null;
  return { sx: cam.w / 2 + (cam.f * dx) / rd, sy: cam.h / 2 - (cam.f * ry) / rd, d: rd };
}

/** Anime line boil. */
function boil(id: number, tick: number): number {
  const n = Math.sin(id * 127.1 + tick * 311.7) * 43758.5453;
  return (n - Math.floor(n) - 0.5) * 2.2;
}

type Mode = 'menu' | 'play' | 'done';
interface DailyStatus { day: number; eligible: boolean; played: boolean; my_entry?: any; players_today: number; coins_total: number }
interface DailyRow { rank: number; player: any; coins: number; millis: bigint }

interface BullRunProps {
  actor: any;
  onGoParticipate: () => void;
  isLocal?: boolean;
}

export default function BullRun({ actor, onGoParticipate, isLocal = false }: BullRunProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [board, setBoard] = useState<DailyRow[]>([]);
  const [result, setResult] = useState<{ coins: number; ms: number; stumbles: number; daily: boolean; rank: number | null } | null>(null);

  const g = useRef<{
    course: Course; bull: BullState; daily: boolean; runId: bigint | null;
    finished: boolean; keys: Record<string, boolean>; t: number;
  } | null>(null);

  const refreshMenu = async () => {
    try {
      const [st, rows] = await Promise.all([
        actor.get_bullrun_daily_status(),
        actor.get_bullrun_daily_board(null),
      ]);
      setStatus(st); setBoard(rows);
    } catch { /* best-effort */ }
  };
  useEffect(() => { refreshMenu(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor]);

  const launch = (seed: number, daily: boolean, runId: bigint | null) => {
    g.current = { course: buildCourse(seed), bull: freshBull(), daily, runId, finished: false, keys: {}, t: 0 };
    setResult(null); setErr(null);
    setMode('play');
  };

  const startPractice = () => launch(Math.floor(Math.random() * 2 ** 31), false, null);

  const startDaily = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await actor.start_bullrun_daily();
      if (res.__kind__ === 'Err') throw new Error(friendlyBullErr(res.Err));
      launch(Number(res.Ok.course_seed % 2_147_483_647n), true, res.Ok.run_id);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const submitDaily = async (coins: number, ms: number) => {
    const game = g.current;
    if (!game?.runId) return null;
    try {
      const res = await actor.complete_bullrun_daily(game.runId, coins, BigInt(Math.max(45_001, Math.round(ms))));
      if (res.__kind__ === 'Err') throw new Error(friendlyBullErr(res.Err));
      return res.Ok as number;
    } catch (e: any) { setErr(e?.message || String(e)); return null; }
  };

  const steer = (dir: -1 | 1) => {
    const game = g.current;
    if (!game || game.finished) return;
    game.bull.lane = Math.max(0, Math.min(2, game.bull.lane + dir));
  };
  const jump = () => {
    const game = g.current;
    if (!game || game.finished || game.bull.y > 0) return;
    game.bull.vy = JUMP_VY;
    game.bull.y = 0.01;
  };

  // ── Input ──
  useEffect(() => {
    if (mode !== 'play') return;
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', 'arrowup', ' '].includes(e.key.toLowerCase()) || e.key === ' ') e.preventDefault();
      if (k === 'arrowleft' || k === 'a') steer(-1);
      if (k === 'arrowright' || k === 'd') steer(1);
      if (k === 'arrowup' || k === 'w' || k === ' ') jump();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Loop ──
  useEffect(() => {
    if (mode !== 'play') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    let doneHandled = false;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const game = g.current;
      if (!game) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      game.t += dt;
      if (!game.finished) {
        stepBull(game.bull, game.course, dt);
        if (game.bull.z >= COURSE_M) {
          game.finished = true;
          if (!doneHandled) {
            doneHandled = true;
            const b = game.bull;
            (async () => {
              const rank = game.daily ? await submitDaily(b.coins, b.t * 1000) : null;
              setResult({ coins: b.coins, ms: b.t * 1000, stumbles: b.stumbles, daily: game.daily, rank });
              setMode('done');
              refreshMenu();
            })();
          }
        }
      }
      draw(ctx, canvas.width, canvas.height, game);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Renderer: warm Spanish street in ink ──
  const INK = '#1a1a1a';
  const draw = (ctx: CanvasRenderingContext2D, W: number, H: number, game: NonNullable<typeof g.current>) => {
    const tick = Math.floor(game.t * 5);
    const b = game.bull;
    const cam: Cam = { x: b.x * 0.55, y: 3.6 + b.y * 0.3, z: b.z - 8.5, pitch: 0.16, f: H * 0.95, w: W, h: H };

    // Warm sky + sun.
    const horizon = project(cam, cam.x, 0, cam.z + 900);
    const hy = Math.max(0, Math.min(H, horizon ? horizon.sy : H * 0.4));
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
    sky.addColorStop(0, '#8ec3e6');
    sky.addColorStop(1, '#f6e2b8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hy);
    ctx.fillStyle = '#f9d976';
    ctx.beginPath(); ctx.arc(W * 0.78, hy * 0.42, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c9a24a'; ctx.lineWidth = 1.5; ctx.stroke();
    // Street surface.
    const road = ctx.createLinearGradient(0, hy, 0, H);
    road.addColorStop(0, '#cfc3ae');
    road.addColorStop(1, '#e5dbc8');
    ctx.fillStyle = road;
    ctx.fillRect(0, hy, W, H - hy);
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';

    // The arena at the end of the street (grows as you approach).
    {
      const az = Math.max(b.z + 60, COURSE_M + 25);
      const c = project(cam, 0, 0, az);
      if (c) {
        const r = Math.max(24, (cam.f * 60) / c.d);
        ctx.fillStyle = '#d8a86a';
        ctx.beginPath(); ctx.ellipse(c.sx, c.sy - r * 0.28, r, r * 0.34, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#b4824a';
        for (let a2 = 0; a2 < 7; a2++) {
          const gx = c.sx - r + (a2 + 0.5) * (r / 3.5);
          ctx.beginPath(); ctx.arc(gx, c.sy - r * 0.06, r * 0.055, Math.PI, 0); ctx.closePath(); ctx.fill();
        }
        ctx.strokeStyle = INK;
      }
    }

    const q: { d: number; draw: () => void }[] = [];

    // Cobblestone bands + curbs.
    for (let cz = Math.floor(b.z / 6) * 6; cz < b.z + 140; cz += 6) {
      const a = project(cam, -STREET_HALF_W, 0, cz);
      const b2 = project(cam, STREET_HALF_W, 0, cz);
      if (!a || !b2) continue;
      q.push({ d: a.d + 3, draw: () => {
        ctx.strokeStyle = 'rgba(90,80,60,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy);
        ctx.quadraticCurveTo((a.sx + b2.sx) / 2, a.sy + 4, b2.sx, b2.sy);
        ctx.stroke();
        ctx.strokeStyle = INK;
      }});
    }
    for (const side of [-1, 1]) {
      const a = project(cam, side * STREET_HALF_W, 0, b.z);
      if (!a) continue;
      q.push({ d: 500, draw: () => {
        ctx.strokeStyle = '#8f8474'; ctx.lineWidth = 2.4;
        ctx.beginPath();
        let started = false;
        for (let cz = b.z - 2; cz < b.z + 160; cz += 8) {
          const pt = project(cam, side * STREET_HALF_W, 0.12, cz);
          if (!pt) continue;
          started ? ctx.lineTo(pt.sx, pt.sy) : ctx.moveTo(pt.sx, pt.sy);
          started = true;
        }
        ctx.stroke();
        ctx.strokeStyle = INK;
      }});
    }

    // Buildings lining the street.
    game.course.buildings.forEach((bd) => {
      if (bd.z + bd.w < b.z - 4 || bd.z > b.z + 180) return;
      const x0 = bd.side * STREET_HALF_W;
      const base = project(cam, x0, 0, Math.max(bd.z, b.z + 0.5));
      if (!base) return;
      q.push({ d: base.d, draw: () => {
        const cnr = (zz: number, y: number) => project(cam, x0, y, zz);
        const p1 = cnr(bd.z, 0), p2 = cnr(bd.z + bd.w, 0), p3 = cnr(bd.z + bd.w, bd.h), p4 = cnr(bd.z, bd.h);
        if (!p1 || !p2 || !p3 || !p4) return;
        const wall = bd.tone < 0.4 ? '#f5efe2' : bd.tone < 0.7 ? '#efe0c0' : '#e6c890';
        ctx.beginPath();
        ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy); ctx.lineTo(p4.sx, p4.sy);
        ctx.closePath();
        ctx.fillStyle = wall; ctx.fill();
        ctx.strokeStyle = '#4a4438'; ctx.lineWidth = 1.4; ctx.stroke();
        // Terracotta roof strip.
        const r4 = cnr(bd.z, bd.h + 1.2), r3 = cnr(bd.z + bd.w, bd.h + 1.2);
        if (r3 && r4) {
          ctx.beginPath();
          ctx.moveTo(p4.sx, p4.sy); ctx.lineTo(p3.sx, p3.sy); ctx.lineTo(r3.sx, r3.sy); ctx.lineTo(r4.sx, r4.sy);
          ctx.closePath();
          ctx.fillStyle = '#b05a3c'; ctx.fill(); ctx.stroke();
        }
        // Windows: dark punches with tiny balconies.
        const rows = Math.max(1, Math.floor(bd.h / 3.4));
        const cols = Math.max(1, Math.floor(bd.w / 4.5));
        for (let rr2 = 0; rr2 < rows; rr2++) {
          for (let cc = 0; cc < cols; cc++) {
            const wz = bd.z + (cc + 0.5) * (bd.w / cols);
            const wy = 1.6 + rr2 * 3.1;
            const wp = project(cam, x0, wy, wz);
            const wp2 = project(cam, x0, wy + 1.4, wz + 0.9);
            if (!wp || !wp2) continue;
            ctx.fillStyle = '#3a332a';
            ctx.fillRect(wp.sx, wp2.sy, Math.max(2, wp2.sx - wp.sx), Math.max(2.5, wp.sy - wp2.sy));
          }
        }
      }});
    });

    // Bunting: catenary of red/yellow flags across the street.
    game.course.buntings.forEach((bz, i) => {
      if (bz < b.z + 2 || bz > b.z + 150) return;
      const a = project(cam, -STREET_HALF_W, 5.4, bz);
      const c2 = project(cam, STREET_HALF_W, 5.4, bz);
      if (!a || !c2) return;
      q.push({ d: a.d, draw: () => {
        const sag = Math.max(6, (cam.f * 0.9) / a.d);
        ctx.strokeStyle = '#4a4438'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo((a.sx + c2.sx) / 2, a.sy + sag * 2, c2.sx, c2.sy); ctx.stroke();
        for (let f2 = 1; f2 < 8; f2++) {
          const tt = f2 / 8;
          const fx = a.sx + (c2.sx - a.sx) * tt;
          const fy = a.sy + (c2.sy - a.sy) * tt + Math.sin(Math.PI * tt) * sag * 1.55;
          const fsz = Math.max(2.5, sag * 0.55);
          ctx.fillStyle = f2 % 2 === 0 ? '#d23b3b' : '#e8b93c';
          ctx.beginPath(); ctx.moveTo(fx - fsz / 2, fy); ctx.lineTo(fx + fsz / 2, fy); ctx.lineTo(fx + boil(i * 9 + f2, tick) * 0.4, fy + fsz);
          ctx.closePath(); ctx.fill();
        }
        ctx.strokeStyle = INK;
      }});
    });

    // Obstacles.
    game.course.obstacles.forEach((o) => {
      if (o.z < b.z - 3 || o.z > b.z + 150) return;
      const base = project(cam, LANE_X[o.lane], 0, o.z);
      if (!base) return;
      q.push({ d: base.d, draw: () => {
        const scale = cam.f / base.d;
        ctx.save();
        ctx.translate(base.sx, base.sy);
        ctx.globalAlpha = o.hit ? 0.35 : 1;
        ctx.strokeStyle = INK;
        if (o.kind === 'barrier') {
          const w2 = scale * 1.15, h2 = scale * 1.0;
          ctx.fillStyle = '#f2ede2';
          ctx.fillRect(-w2, -h2, w2 * 2, h2 * 0.8);
          ctx.fillStyle = '#d23b3b';
          for (let sgm = 0; sgm < 4; sgm += 2) {
            ctx.fillRect(-w2 + (sgm * w2) / 2, -h2, w2 / 2, h2 * 0.8);
          }
          ctx.lineWidth = 1.4;
          ctx.strokeRect(-w2, -h2, w2 * 2, h2 * 0.8);
          ctx.beginPath(); ctx.moveTo(-w2 * 0.8, 0); ctx.lineTo(-w2 * 0.6, -h2 * 0.25);
          ctx.moveTo(w2 * 0.8, 0); ctx.lineTo(w2 * 0.6, -h2 * 0.25); ctx.stroke();
        } else if (o.kind === 'barrels') {
          const r2 = scale * 0.55;
          for (const ox of [-0.55, 0.55]) {
            ctx.fillStyle = '#9c6b3f';
            ctx.beginPath(); ctx.ellipse(ox * scale, -r2, r2 * 0.8, r2, 0, 0, Math.PI * 2); ctx.fill();
            ctx.lineWidth = 1.3; ctx.stroke();
            ctx.strokeStyle = '#5a3d24';
            ctx.beginPath(); ctx.moveTo(ox * scale - r2 * 0.75, -r2); ctx.lineTo(ox * scale + r2 * 0.75, -r2); ctx.stroke();
            ctx.strokeStyle = INK;
          }
        } else {
          // Cart: tall wooden box + wheels — unjumpable.
          const w2 = scale * 1.3, h2 = scale * 2.3;
          ctx.fillStyle = '#8a5a34';
          ctx.fillRect(-w2, -h2, w2 * 2, h2 * 0.9);
          ctx.lineWidth = 1.6;
          ctx.strokeRect(-w2, -h2, w2 * 2, h2 * 0.9);
          ctx.strokeStyle = '#5a3d24';
          ctx.beginPath(); ctx.moveTo(-w2, -h2 * 0.55); ctx.lineTo(w2, -h2 * 0.55); ctx.stroke();
          ctx.strokeStyle = INK;
          ctx.fillStyle = '#3a332a';
          for (const wx of [-0.75, 0.75]) {
            ctx.beginPath(); ctx.arc(wx * scale, -scale * 0.32, scale * 0.34, 0, Math.PI * 2); ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      }});
    });

    // Coins: spinning gold with ground shadow.
    game.course.coins.forEach((c2, ci) => {
      if (c2.taken || c2.z < b.z - 2 || c2.z > b.z + 120) return;
      const pt = project(cam, LANE_X[c2.lane], c2.y, c2.z);
      const gp = project(cam, LANE_X[c2.lane], 0, c2.z);
      if (!pt) return;
      q.push({ d: pt.d, draw: () => {
        const r2 = Math.max(2.2, (cam.f * 0.32) / pt.d);
        if (gp) {
          ctx.fillStyle = 'rgba(70,60,30,0.2)';
          ctx.beginPath(); ctx.ellipse(gp.sx, gp.sy, r2 * 0.9, r2 * 0.3, 0, 0, Math.PI * 2); ctx.fill();
        }
        const spin = Math.abs(Math.sin(game.t * 4 + ci));
        ctx.fillStyle = '#e8b93c';
        ctx.beginPath(); ctx.ellipse(pt.sx, pt.sy, r2 * Math.max(0.25, spin), r2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#8a6a1a'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.strokeStyle = INK;
      }});
    });

    q.sort((a, b2) => b2.d - a.d).forEach((o) => o.draw());

    // ── The bull (always on top) ──
    {
      const c = project(cam, b.x, b.y + 0.55, b.z);
      const gp = project(cam, b.x, 0, b.z);
      if (gp) {
        ctx.fillStyle = 'rgba(40,35,25,0.3)';
        const sr = Math.max(6, (cam.f * 1.1) / gp.d);
        ctx.beginPath(); ctx.ellipse(gp.sx, gp.sy, sr, sr * 0.3, 0, 0, Math.PI * 2); ctx.fill();
      }
      if (c) {
        const s2 = Math.max(10, (cam.f * 1.05) / c.d);
        const gallop = Math.sin(b.z * 1.7);
        const flash = b.invulnT > 0 && Math.floor(game.t * 10) % 2 === 0;
        ctx.save();
        ctx.translate(c.sx, c.sy);
        ctx.rotate((LANE_X[b.lane] - b.x) * 0.16);
        ctx.globalAlpha = flash ? 0.45 : 1;
        ctx.strokeStyle = INK;
        // Legs (gallop phases).
        ctx.lineWidth = Math.max(2.4, s2 * 0.16);
        ctx.beginPath();
        for (const [lx, ph] of [[-0.55, 0], [-0.25, 2.2], [0.28, 1.1], [0.55, 3.3]] as const) {
          const swing = Math.sin(b.z * 1.7 + ph) * 0.35;
          ctx.moveTo(lx * s2, s2 * 0.28);
          ctx.lineTo(lx * s2 + swing * s2, s2 * 0.75);
        }
        ctx.stroke();
        // Body — a charging black mass, hump forward.
        ctx.fillStyle = '#141414';
        ctx.beginPath();
        ctx.ellipse(0, 0, s2 * 0.85, s2 * 0.42 + gallop * s2 * 0.02, -0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(s2 * 0.52, -s2 * 0.18, s2 * 0.38, s2 * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        // Head (facing away, slightly down) + white horns.
        ctx.beginPath();
        ctx.ellipse(s2 * 0.78, -s2 * 0.06, s2 * 0.22, s2 * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#f5f2ea'; ctx.lineWidth = Math.max(2, s2 * 0.12);
        ctx.beginPath();
        ctx.moveTo(s2 * 0.68, -s2 * 0.22); ctx.quadraticCurveTo(s2 * 0.58, -s2 * 0.5, s2 * 0.78, -s2 * 0.56);
        ctx.moveTo(s2 * 0.9, -s2 * 0.22); ctx.quadraticCurveTo(s2 * 1.0, -s2 * 0.5, s2 * 0.82, -s2 * 0.56);
        ctx.stroke();
        // Tail whip.
        ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.6, s2 * 0.08);
        ctx.beginPath();
        ctx.moveTo(-s2 * 0.8, -s2 * 0.1);
        ctx.quadraticCurveTo(-s2 * 1.1, -s2 * 0.3 + gallop * s2 * 0.15, -s2 * 1.2, -s2 * 0.05);
        ctx.stroke();
        ctx.restore();
        // Dust puffs at speed.
        if (b.y === 0 && b.speed > 15) {
          ctx.fillStyle = 'rgba(160,145,110,0.35)';
          for (let d2 = 0; d2 < 3; d2++) {
            const px = c.sx - s2 * (0.9 + d2 * 0.35) + boil(d2, tick) * 2;
            ctx.beginPath(); ctx.arc(px, c.sy + s2 * 0.45, s2 * (0.12 + d2 * 0.05), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }

    // ── HUD ──
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(8, 8, 140, 60);
    ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 1; ctx.strokeRect(8, 8, 140, 60);
    ctx.fillStyle = '#c9931a';
    ctx.beginPath(); ctx.arc(22, 24, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a6a1a'; ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = '700 14px ui-monospace, monospace';
    ctx.fillText(`${b.coins}/${COINS_TOTAL}`, 34, 29);
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillText(`${Math.round(b.speed * 3.6)} km/h`, 14, 47);
    ctx.fillText(`${b.t.toFixed(1)} s`, 14, 62);
    // Progress to the arena.
    const pw = Math.min(320, W * 0.5), px0 = (W - pw) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(px0, 12, pw, 9);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.strokeRect(px0, 12, pw, 9);
    ctx.fillStyle = '#d23b3b';
    ctx.fillRect(px0, 12, pw * Math.min(1, b.z / COURSE_M), 9);
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText('PLAZA DE TOROS', px0 + pw / 2, 31);
    if (b.z < 40) {
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(game.t * 6);
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.fillText('¡A LA PLAZA!', W / 2, H * 0.3);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  };

  const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

  return (
    <div className="col" style={{ gap: 12, maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', borderBottom: '2px solid var(--border)', paddingBottom: 10 }}>
        <b style={{ fontSize: 14, letterSpacing: '0.04em' }}>
          BULL RUN <span style={{ color: 'var(--fg-3)' }}>// {mode === 'play' ? (g.current?.daily ? 'DAILY RUN' : 'PRACTICE') : 'ARCADE'}</span>
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
              <b style={{ fontSize: 15 }}>Free runs</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                A fresh street every run, nothing recorded. <span className="mono">←/→</span> cut
                across the lanes, <span className="mono">↑/SPACE</span> jumps the barriers and
                barrels — <b>carts can't be jumped</b>, go around. Every stumble halves your
                speed; the coins don't collect themselves.
              </p>
              <Btn variant="secondary" onClick={startPractice}><Icon name="bull" size={13} /> Run</Btn>
            </div>
            <div className="card col" style={{ gap: 10, borderColor: 'var(--burn)' }}>
              <Chip tone="burn" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>
                <LiveDot color="var(--burn-ink)" size={5} /> Daily run
              </Chip>
              <b style={{ fontSize: 15 }}>One run · same street for everyone</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Everyone charges today's exact street — same barriers, same carts, same{' '}
                {status?.coins_total ?? 120} coins. Most coins wins; ties go to the faster
                bull. <b>One attempt — no restarts.</b> Resets 00:00 UTC.
              </p>
              {status && !status.eligible ? (
                <div className="col" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--haze-ink)' }}>
                    <Icon name="lock" size={13} stroke="var(--haze-ink)" /> The daily run is for no-loss-lottery stakers.
                  </span>
                  <Btn variant="primary" onClick={onGoParticipate}><Icon name="zap" size={13} stroke="var(--char-950)" /> Stake ICP to enter</Btn>
                </div>
              ) : status?.played && !isLocal ? (
                <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                  <Icon name="checkCircle" size={11} /> Ran today{status.my_entry ? ` — ${status.my_entry.coins} coins` : ''}
                </Chip>
              ) : (
                <div className="col" style={{ gap: 6 }}>
                  <Btn variant="primary" disabled={busy || !status} onClick={startDaily}>
                    {busy ? <LiveDot size={8} /> : <Icon name="bull" size={13} stroke="var(--char-950)" />} Release the bull
                  </Btn>
                  {isLocal && status?.played && (
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>local net — daily retries unlimited</span>
                  )}
                </div>
              )}
            </div>
          </div>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}

          <div className="card col" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <b style={{ fontSize: 13.5 }}>Today's board</b>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>coins · time · {status?.players_today ?? 0} ran</span>
            </span>
            {board.length === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>The street is quiet — first bull sets the pace.</span>
            ) : (
              <div className="col" style={{ gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                {board.map((r) => (
                  <span key={r.rank} className="row mono" style={{ gap: 8, fontSize: 12, justifyContent: 'space-between', padding: '5px 4px', borderBottom: '1px solid var(--border)' }}>
                    <span>#{r.rank} {formatPrincipal(r.player)}</span>
                    <span>{r.coins} coins · {fmtS(Number(r.millis))}</span>
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
            height={440}
            style={{ width: '100%', height: 'auto', borderRadius: 10, border: '1px solid var(--border-hi)', touchAction: 'none', background: '#e9dfc8' }}
          />
          <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Btn variant="secondary" sm onClick={() => steer(-1)} style={{ minWidth: 96, minHeight: 46 }}>◀ LANE</Btn>
            <Btn variant="primary" sm onClick={jump} style={{ minWidth: 120, minHeight: 46 }}>▲ JUMP</Btn>
            <Btn variant="secondary" sm onClick={() => steer(1)} style={{ minWidth: 96, minHeight: 46 }}>LANE ▶</Btn>
          </div>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textAlign: 'center' }}>
            ←/→ lanes · ↑/space jump · carts can't be jumped — dodge them
          </span>
        </div>
      )}

      {mode === 'done' && result && (
        <div className="card col" style={{ gap: 12 }}>
          <h3 style={{ margin: 0 }}>
            {result.coins === COINS_TOTAL ? '¡PERFECTO! Every coin in the street.' : `Reached the plaza with ${result.coins} coins.`}
          </h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Chip tone="ok"><span className="mono">{result.coins}/{COINS_TOTAL} coins · {fmtS(result.ms)}</span></Chip>
            <Chip tone="muted"><span className="mono">{result.stumbles} stumble{result.stumbles === 1 ? '' : 's'}</span></Chip>
            {result.daily && result.rank !== null && (
              <Chip tone="burn"><span className="mono">rank #{result.rank} today</span></Chip>
            )}
          </div>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
          <div className="row" style={{ gap: 8 }}>
            {!result.daily && <Btn variant="primary" onClick={startPractice}><Icon name="bull" size={13} stroke="var(--char-950)" /> Run again</Btn>}
            <Btn variant="secondary" onClick={() => { setMode('menu'); g.current = null; refreshMenu(); }}>Back to the board</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
