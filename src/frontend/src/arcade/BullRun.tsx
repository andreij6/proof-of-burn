import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon, LiveDot, formatPrincipal } from '../ui';
import { mulberry } from './DropZone';

// ==========================================
// Bull Run — arcade game 5: the ENDLESS encierro.
//
// You are the bull, seen from behind (the Pamplona press-photo view): black
// shoulders and rump filling the frame, white horns out front, the street
// ahead packed with runners in white and red scarves scattering as you
// charge. The run never ends — it just gets harder: the bull accelerates
// with distance, obstacles pack tighter, and the crowd thickens until it
// genuinely blocks your view of what's behind it. TEN hits and the run is
// over. Coins line the street; most coins wins the daily, ties to time.
//
// The street streams procedurally from independent seeded generators (one
// per subsystem), so any two clients extending it in different chunk sizes
// still build the IDENTICAL street — the daily stays fair.
// ==========================================

// ── Constants ──
export const LANE_X = [-2.4, 0, 2.4];
export const STREET_HALF_W = 4.2;
export const MAX_HITS = 10;      // run ends here (mirrors backend hits_limit)
export const BASE_SPEED = 13;
export const STUMBLE_FACTOR = 0.5;
export const JUMP_VY = 7.8;
export const GRAVITY = 20;
export const BARRIER_CLEAR = 0.8;

export type ObstacleKind = 'barrier' | 'barrels' | 'cart';
export interface Obstacle { z: number; lane: number; kind: ObstacleKind; hit?: boolean }
export interface Coin { z: number; lane: number; y: number; taken?: boolean }
export interface Building { z: number; side: -1 | 1; w: number; h: number; tone: number; awning: boolean; balcony: boolean }
export interface CrowdAgent { z: number; x: number; wallX: number; dodge: boolean; phase: number }

/** Difficulty is a pure function of distance — layout AND handling both
 *  scale from it, so the same z means the same challenge for everyone. */
export function difficultyAt(z: number): { spacing: number; doubleP: number; crowdGap: number; maxSpeed: number } {
  const t = Math.min(1, z / 4_000);
  return {
    spacing: 26 - 16 * t,          // avg m between obstacle slots: 26 → 10
    doubleP: 0.3 + 0.25 * t,       // chance a slot blocks a second lane
    crowdGap: 14 - 9.5 * t,        // avg m between runners: 14 → 4.5
    maxSpeed: Math.min(34, 16 + z / 300), // the bull just keeps accelerating
  };
}

export interface Street {
  obstacles: Obstacle[];
  coins: Coin[];
  buildings: Building[];
  buntings: number[];
  crowd: CrowdAgent[];
  genZ: number; // generated up to here
  // Independent deterministic streams — chunk-size can't change the street.
  rObs: () => number;
  rCoin: () => number;
  rBld: () => number;
  rCrowd: () => number;
  // Per-subsystem cursors.
  cObs: number; cCoin: number; cBldL: number; cBldR: number; cFlag: number; cCrowd: number;
}

export function makeStreet(seed: number): Street {
  const st: Street = {
    obstacles: [], coins: [], buildings: [], buntings: [], crowd: [],
    genZ: 0,
    rObs: mulberry((seed ^ 0x0b57) >>> 0),
    rCoin: mulberry((seed ^ 0xc019) >>> 0),
    rBld: mulberry((seed ^ 0xb11d) >>> 0),
    rCrowd: mulberry((seed ^ 0xc80d) >>> 0),
    cObs: 55, cCoin: 40, cBldL: -20, cBldR: -20, cFlag: 90, cCrowd: 30,
  };
  ensureStreet(st, 320);
  return st;
}

/** Stream the street out to `upToZ`. Deterministic for any chunking: each
 *  subsystem consumes only its own PRNG, in strict z order. */
export function ensureStreet(st: Street, upToZ: number): void {
  if (upToZ <= st.genZ) return;
  // Obstacles: spacing and double-blocks scale with difficulty; the third
  // lane is ALWAYS open.
  while (st.cObs < upToZ) {
    const d = difficultyAt(st.cObs);
    const lane = Math.floor(st.rObs() * 3);
    const roll = st.rObs();
    const kind: ObstacleKind = roll < 0.45 ? 'barrier' : roll < 0.75 ? 'barrels' : 'cart';
    st.obstacles.push({ z: st.cObs, lane, kind });
    if (st.rObs() < d.doubleP) {
      const lane2 = (lane + 1 + Math.floor(st.rObs() * 2)) % 3;
      st.obstacles.push({ z: st.cObs, lane: lane2, kind: st.rObs() < 0.6 ? 'barrier' : 'barrels' });
    }
    st.cObs += d.spacing * (0.75 + st.rObs() * 0.5);
  }
  // Coins: runs of 6, ground or jump-arc.
  while (st.cCoin < upToZ) {
    const lane = Math.floor(st.rCoin() * 3);
    const arc = st.rCoin() < 0.4;
    for (let i = 0; i < 6; i++) {
      st.coins.push({ z: st.cCoin + i * 4, lane, y: arc ? 0.6 + Math.sin((i / 5) * Math.PI) * 1.3 : 0.55 });
    }
    st.cCoin += 34 + st.rCoin() * 26;
  }
  // Buildings, both walls.
  // Facades run shoulder-to-shoulder — a gap would leak sky into the canyon.
  while (st.cBldL < upToZ + 60) {
    const w = 12 + st.rBld() * 10;
    st.buildings.push({ z: st.cBldL, side: -1, w, h: 7 + st.rBld() * 8, tone: st.rBld(), awning: st.rBld() < 0.35, balcony: st.rBld() < 0.45 });
    st.cBldL += w;
  }
  while (st.cBldR < upToZ + 60) {
    const w = 12 + st.rBld() * 10;
    st.buildings.push({ z: st.cBldR, side: 1, w, h: 7 + st.rBld() * 8, tone: st.rBld(), awning: st.rBld() < 0.35, balcony: st.rBld() < 0.45 });
    st.cBldR += w;
  }
  while (st.cFlag < upToZ) {
    st.buntings.push(st.cFlag);
    st.cFlag += 70 + st.rBld() * 50;
  }
  // The crowd: runners scattered across the street, thicker with distance.
  while (st.cCrowd < upToZ) {
    const d = difficultyAt(st.cCrowd);
    const x = (st.rCrowd() * 2 - 1) * (STREET_HALF_W - 0.7);
    st.crowd.push({
      z: st.cCrowd, x,
      wallX: (x >= 0 ? 1 : -1) * (STREET_HALF_W - 0.35),
      dodge: false,
      phase: st.rCrowd() * Math.PI * 2,
    });
    st.cCrowd += d.crowdGap * (0.6 + st.rCrowd() * 0.8);
  }
  st.genZ = upToZ;
}

/** Prune everything the bull has passed (endless arrays stay small). */
export function pruneStreet(st: Street, behindZ: number): void {
  st.obstacles = st.obstacles.filter((o) => o.z > behindZ);
  st.coins = st.coins.filter((c) => c.z > behindZ);
  st.buildings = st.buildings.filter((b) => b.z + b.w > behindZ);
  st.buntings = st.buntings.filter((b) => b > behindZ);
  st.crowd = st.crowd.filter((c) => c.z > behindZ);
}

/** Runners near the bull's path bolt for the nearest wall. */
export function stepCrowd(st: Street, bullX: number, bullZ: number, dt: number): void {
  for (const a of st.crowd) {
    const ahead = a.z - bullZ;
    if (!a.dodge && ahead > 0 && ahead < 22 && Math.abs(a.x - bullX) < 2.1) {
      a.dodge = true;
    }
    if (a.dodge && Math.abs(a.x - a.wallX) > 0.05) {
      a.x += Math.sign(a.wallX - a.x) * 4.2 * dt;
      a.z += 2.2 * dt; // panicked jog forward while clearing out
    }
    a.phase += dt * (a.dodge ? 14 : 3);
  }
}

export function obstacleClearY(kind: ObstacleKind): number {
  return kind === 'cart' ? 99 : BARRIER_CLEAR;
}

// ── Bull ──
export interface BullState {
  z: number; lane: number; x: number; y: number; vy: number;
  speed: number; coins: number; stumbles: number; invulnT: number; t: number;
}

export function freshBull(): BullState {
  return { z: 0, lane: 1, x: 0, y: 0, vy: 0, speed: BASE_SPEED, coins: 0, stumbles: 0, invulnT: 0, t: 0 };
}

/** One step of the endless run. The speed ceiling comes from difficultyAt —
 *  the deeper you get, the faster the street comes at you. */
export function stepBull(b: BullState, st: Street, dt: number): BullState {
  b.t += dt;
  const cap = difficultyAt(b.z).maxSpeed;
  b.speed = Math.min(cap, b.speed + 1.2 * dt);
  b.z += b.speed * dt;
  b.x += (LANE_X[b.lane] - b.x) * Math.min(1, dt * 9);
  if (b.y > 0 || b.vy > 0) {
    b.vy -= GRAVITY * dt;
    b.y = Math.max(0, b.y + b.vy * dt);
    if (b.y === 0) b.vy = 0;
  }
  if (b.invulnT > 0) b.invulnT = Math.max(0, b.invulnT - dt);
  for (const c of st.coins) {
    if (c.taken || Math.abs(c.z - b.z) > 1.4) continue;
    if (c.lane !== b.lane) continue;
    if (Math.abs(c.y - (b.y + 0.5)) < 1.05) {
      c.taken = true;
      b.coins += 1;
    }
  }
  if (b.invulnT === 0) {
    for (const o of st.obstacles) {
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

// ── Sound: tiny synthesized effects (no assets — the CSP allows no fetches) ──
let actx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    if (!actx) actx = new AudioContext();
    if (actx.state === 'suspended') void actx.resume();
    return actx;
  } catch { return null; }
}

/** Coin: a bright two-step chime. */
export function playCoinSound(): void {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(988, t);
  osc.frequency.setValueAtTime(1319, t + 0.06);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}

/** Hit: a low thud — dropping square + a burst of filtered noise. */
export function playHitSound(): void {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const og = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(130, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.22);
  og.gain.setValueAtTime(0.22, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
  osc.connect(og).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.28);
  const len = Math.floor(ctx.sampleRate * 0.12);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 420;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.3, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  noise.connect(filt).connect(ng).connect(ctx.destination);
  noise.start(t);
}

export function friendlyBullErr(code: string): string {
  switch (code) {
    case 'NOT_STAKED': return 'The daily run is for no-loss-lottery stakers — stake any amount of ICP to enter.';
    case 'ALREADY_PLAYED_TODAY': return 'You\'ve run today\'s street — a fresh course opens at 00:00 UTC.';
    case 'RUN_EXPIRED': return 'This run timed out (30-minute limit). Today\'s attempt was consumed.';
    default: return code;
  }
}

// ── Projection (chase cam, slightly high — the press-photo angle) ──
interface Cam { x: number; y: number; z: number; pitch: number; f: number; w: number; h: number }
function project(cam: Cam, wx: number, wy: number, wz: number): { sx: number; sy: number; d: number } | null {
  const dx = wx - cam.x, dy = wy - cam.y, dz = wz - cam.z;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const ry = dy * cp + dz * sp;
  const rd = dz * cp - dy * sp;
  if (rd < 0.8) return null;
  return { sx: cam.w / 2 + (cam.f * dx) / rd, sy: cam.h / 2 - (cam.f * ry) / rd, d: rd };
}

function boil(id: number, tick: number): number {
  const n = Math.sin(id * 127.1 + tick * 311.7) * 43758.5453;
  return (n - Math.floor(n) - 0.5) * 2.2;
}

type Mode = 'menu' | 'play' | 'done';
interface DailyStatus { day: number; eligible: boolean; played: boolean; my_entry?: any; players_today: number; hits_limit: number }
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
  const [result, setResult] = useState<{ coins: number; ms: number; dist: number; daily: boolean; rank: number | null } | null>(null);

  const g = useRef<{
    street: Street; bull: BullState; daily: boolean; runId: bigint | null;
    finished: boolean; keys: Record<string, boolean>; t: number; lastPrune: number;
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
    g.current = { street: makeStreet(seed), bull: freshBull(), daily, runId, finished: false, keys: {}, t: 0, lastPrune: 0 };
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
      const res = await actor.complete_bullrun_daily(game.runId, coins, BigInt(Math.max(10_001, Math.round(ms))));
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

  useEffect(() => {
    if (mode !== 'play') return;
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', 'arrowup'].includes(k) || e.key === ' ') e.preventDefault();
      if (k === 'arrowleft' || k === 'a') steer(-1);
      if (k === 'arrowright' || k === 'd') steer(1);
      if (k === 'arrowup' || k === 'w' || k === ' ') jump();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
        ensureStreet(game.street, game.bull.z + 280);
        const prevCoins = game.bull.coins;
        const prevHits = game.bull.stumbles;
        stepBull(game.bull, game.street, dt);
        if (game.bull.coins > prevCoins) playCoinSound();
        if (game.bull.stumbles > prevHits) playHitSound();
        stepCrowd(game.street, game.bull.x, game.bull.z, dt);
        if (game.bull.z - game.lastPrune > 120) {
          pruneStreet(game.street, game.bull.z - 30);
          game.lastPrune = game.bull.z;
        }
        if (game.bull.stumbles >= MAX_HITS) {
          game.finished = true;
          if (!doneHandled) {
            doneHandled = true;
            const b = game.bull;
            (async () => {
              const rank = game.daily ? await submitDaily(b.coins, b.t * 1000) : null;
              setResult({ coins: b.coins, ms: b.t * 1000, dist: b.z, daily: game.daily, rank });
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

  // ── Renderer ──
  const INK = '#1a1a1a';
  const draw = (ctx: CanvasRenderingContext2D, W: number, H: number, game: NonNullable<typeof g.current>) => {
    const tick = Math.floor(game.t * 5);
    const b = game.bull;
    // Higher, steeper chase cam — the press-photo look down onto the bull.
    const cam: Cam = { x: b.x * 0.55, y: 4.6 + b.y * 0.3, z: b.z - 7.5, pitch: 0.24, f: H * 0.98, w: W, h: H };

    const horizon = project(cam, cam.x, 0, cam.z + 900);
    const hy = Math.max(0, Math.min(H, horizon ? horizon.sy : H * 0.35));
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
    sky.addColorStop(0, '#8ec3e6');
    sky.addColorStop(1, '#f6e2b8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hy);
    // Sun sits at the street's vanishing point — anything built after this
    // (backdrops, walls) occludes it naturally.
    ctx.fillStyle = '#f9d976';
    ctx.beginPath(); ctx.arc(W * 0.5, hy * 0.45, 22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c9a24a'; ctx.lineWidth = 1.5; ctx.stroke();
    const road = ctx.createLinearGradient(0, hy, 0, H);
    road.addColorStop(0, '#cfc3ae');
    road.addColorStop(1, '#e5dbc8');
    ctx.fillStyle = road;
    ctx.fillRect(0, hy, W, H - hy);
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';

    // Backdrop walls: one tall muted plane per side, camera to deep distance —
    // the sky and sun can never show through or above a gap in the buildings.
    for (const side of [-1, 1] as const) {
      const x0 = side * STREET_HALF_W;
      const zn = cam.z + 1.2, zf = b.z + 400;
      const b1 = project(cam, x0, 0, zn), b2 = project(cam, x0, 30, zn);
      const f1 = project(cam, x0, 0, zf), f2 = project(cam, x0, 30, zf);
      if (b1 && b2 && f1 && f2) {
        ctx.beginPath();
        ctx.moveTo(b1.sx, b1.sy); ctx.lineTo(f1.sx, f1.sy); ctx.lineTo(f2.sx, f2.sy); ctx.lineTo(b2.sx, b2.sy);
        ctx.closePath();
        ctx.fillStyle = '#d9cdb2';
        ctx.fill();
      }
    }

    const q: { d: number; draw: () => void }[] = [];

    // Cobble bands.
    for (let cz = Math.floor(b.z / 6) * 6; cz < b.z + 130; cz += 6) {
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

    // Buildings with awnings, balconies, shutters.
    game.street.buildings.forEach((bd) => {
      if (bd.z + bd.w < b.z - 4 || bd.z > b.z + 170) return;
      const x0 = bd.side * STREET_HALF_W;
      const base = project(cam, x0, 0, Math.max(bd.z, b.z + 0.5));
      if (!base) return;
      q.push({ d: base.d, draw: () => {
        const cnr = (zz: number, y: number) => project(cam, x0, y, zz);
        // Clamp the near edge to just in front of the camera: a wall the
        // bull is passing stays on screen instead of vanishing when its
        // corner crosses the near plane.
        const zNear = Math.max(bd.z, cam.z + 1.2);
        const p1 = cnr(zNear, 0), p2 = cnr(bd.z + bd.w, 0), p3 = cnr(bd.z + bd.w, bd.h), p4 = cnr(zNear, bd.h);
        if (!p1 || !p2 || !p3 || !p4) return;
        const wall = bd.tone < 0.35 ? '#f5efe2' : bd.tone < 0.6 ? '#efe0c0' : bd.tone < 0.85 ? '#e6c890' : '#dba9a0';
        ctx.beginPath();
        ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy); ctx.lineTo(p4.sx, p4.sy);
        ctx.closePath();
        ctx.fillStyle = wall; ctx.fill();
        ctx.strokeStyle = '#4a4438'; ctx.lineWidth = 1.4; ctx.stroke();
        const r4 = cnr(zNear, bd.h + 1.2), r3 = cnr(bd.z + bd.w, bd.h + 1.2);
        if (r3 && r4) {
          ctx.beginPath();
          ctx.moveTo(p4.sx, p4.sy); ctx.lineTo(p3.sx, p3.sy); ctx.lineTo(r3.sx, r3.sy); ctx.lineTo(r4.sx, r4.sy);
          ctx.closePath();
          ctx.fillStyle = '#b05a3c'; ctx.fill(); ctx.stroke();
          // Roof tile ticks.
          ctx.strokeStyle = 'rgba(90,40,25,0.5)'; ctx.lineWidth = 0.9;
          for (let tt = 0.15; tt < 1; tt += 0.18) {
            const tx1 = p4.sx + (p3.sx - p4.sx) * tt, ty1 = p4.sy + (p3.sy - p4.sy) * tt;
            const tx2 = r4.sx + (r3.sx - r4.sx) * tt, ty2 = r4.sy + (r3.sy - r4.sy) * tt;
            ctx.beginPath(); ctx.moveTo(tx1, ty1); ctx.lineTo(tx2, ty2); ctx.stroke();
          }
          ctx.strokeStyle = '#4a4438';
        }
        // Windows with shutters; balconies on some rows.
        const rows = Math.max(1, Math.floor(bd.h / 3.4));
        const cols = Math.max(1, Math.floor(bd.w / 4.5));
        for (let rr2 = 0; rr2 < rows; rr2++) {
          for (let cc = 0; cc < cols; cc++) {
            const wz = bd.z + (cc + 0.5) * (bd.w / cols);
            const wy = 1.8 + rr2 * 3.1;
            const wp = project(cam, x0, wy, wz);
            const wp2 = project(cam, x0, wy + 1.4, wz + 0.9);
            if (!wp || !wp2) continue;
            const ww = Math.max(2, wp2.sx - wp.sx), wh = Math.max(2.5, wp.sy - wp2.sy);
            ctx.fillStyle = '#3a332a';
            ctx.fillRect(wp.sx, wp2.sy, ww, wh);
            // Shutters.
            ctx.fillStyle = '#6d8a56';
            ctx.fillRect(wp.sx - ww * 0.35, wp2.sy, ww * 0.28, wh);
            ctx.fillRect(wp.sx + ww * 1.07, wp2.sy, ww * 0.28, wh);
            // Balcony rail under upper-floor windows.
            if (bd.balcony && rr2 > 0) {
              ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 0.9;
              ctx.strokeRect(wp.sx - ww * 0.3, wp2.sy + wh, ww * 1.6, Math.max(1.5, wh * 0.3));
              for (let bx = 0; bx <= 4; bx++) {
                const rx = wp.sx - ww * 0.3 + (ww * 1.6 * bx) / 4;
                ctx.beginPath(); ctx.moveTo(rx, wp2.sy + wh); ctx.lineTo(rx, wp2.sy + wh + Math.max(1.5, wh * 0.3)); ctx.stroke();
              }
              ctx.strokeStyle = '#4a4438';
            }
          }
        }
        // Corner shading at the join to the next building — depth cue.
        ctx.strokeStyle = 'rgba(60,50,40,0.55)';
        ctx.lineWidth = Math.max(1.5, (cam.f * 0.28) / p2.d);
        ctx.beginPath(); ctx.moveTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy); ctx.stroke();
        ctx.strokeStyle = '#4a4438';
        // Street-level awning.
        if (bd.awning) {
          const az1 = cnr(bd.z + bd.w * 0.2, 2.6), az2 = cnr(bd.z + bd.w * 0.8, 2.6);
          const ax1 = project(cam, x0 * 0.82, 2.1, bd.z + bd.w * 0.2);
          const ax2 = project(cam, x0 * 0.82, 2.1, bd.z + bd.w * 0.8);
          if (az1 && az2 && ax1 && ax2) {
            ctx.beginPath();
            ctx.moveTo(az1.sx, az1.sy); ctx.lineTo(az2.sx, az2.sy); ctx.lineTo(ax2.sx, ax2.sy); ctx.lineTo(ax1.sx, ax1.sy);
            ctx.closePath();
            ctx.fillStyle = bd.tone < 0.5 ? '#d23b3b' : '#e8b93c';
            ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke();
          }
        }
      }});
    });

    // Bunting.
    game.street.buntings.forEach((bz, i) => {
      if (bz < b.z + 2 || bz > b.z + 140) return;
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
    game.street.obstacles.forEach((o) => {
      if (o.z < b.z - 3 || o.z > b.z + 140) return;
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
          for (let sgm = 0; sgm < 4; sgm += 2) ctx.fillRect(-w2 + (sgm * w2) / 2, -h2, w2 / 2, h2 * 0.8);
          ctx.lineWidth = 1.4;
          ctx.strokeRect(-w2, -h2, w2 * 2, h2 * 0.8);
        } else if (o.kind === 'barrels') {
          const r2 = scale * 0.55;
          for (const ox of [-0.55, 0.55]) {
            ctx.fillStyle = '#9c6b3f';
            ctx.beginPath(); ctx.ellipse(ox * scale, -r2, r2 * 0.8, r2, 0, 0, Math.PI * 2); ctx.fill();
            ctx.lineWidth = 1.3; ctx.stroke();
          }
        } else {
          const w2 = scale * 1.3, h2 = scale * 2.3;
          ctx.fillStyle = '#8a5a34';
          ctx.fillRect(-w2, -h2, w2 * 2, h2 * 0.9);
          ctx.lineWidth = 1.6;
          ctx.strokeRect(-w2, -h2, w2 * 2, h2 * 0.9);
          ctx.fillStyle = '#3a332a';
          for (const wx of [-0.75, 0.75]) {
            ctx.beginPath(); ctx.arc(wx * scale, -scale * 0.32, scale * 0.34, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
        }
        ctx.restore();
      }});
    });

    // Coins.
    game.street.coins.forEach((c2, ci) => {
      if (c2.taken || c2.z < b.z - 2 || c2.z > b.z + 110) return;
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

    // ── The crowd: white shirts, red scarves, scattering as you come ──
    game.street.crowd.forEach((a) => {
      if (a.z < b.z - 2 || a.z > b.z + 130) return;
      const pt = project(cam, a.x, 0, a.z);
      if (!pt) return;
      q.push({ d: pt.d, draw: () => {
        const s2 = Math.max(4, (cam.f * 0.62) / pt.d);
        const legSwing = Math.sin(a.phase) * (a.dodge ? 0.5 : 0.12);
        ctx.save();
        ctx.translate(pt.sx, pt.sy);
        // Shadow.
        ctx.fillStyle = 'rgba(40,35,25,0.22)';
        ctx.beginPath(); ctx.ellipse(0, 0, s2 * 0.4, s2 * 0.13, 0, 0, Math.PI * 2); ctx.fill();
        // Legs (white trousers).
        ctx.strokeStyle = '#f2efe6'; ctx.lineWidth = Math.max(1.6, s2 * 0.16);
        ctx.beginPath();
        ctx.moveTo(-legSwing * s2 * 0.5, 0); ctx.lineTo(0, -s2 * 0.75);
        ctx.moveTo(legSwing * s2 * 0.5, 0); ctx.lineTo(0, -s2 * 0.75);
        ctx.stroke();
        // Torso (white shirt) + ink outline.
        ctx.fillStyle = '#faf8f2';
        ctx.beginPath();
        ctx.ellipse(0, -s2 * 1.05, s2 * 0.3, s2 * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(30,30,30,0.6)'; ctx.lineWidth = 1; ctx.stroke();
        // Arms — flailing when dodging.
        ctx.strokeStyle = '#faf8f2'; ctx.lineWidth = Math.max(1.4, s2 * 0.13);
        const armUp = a.dodge ? -0.5 : 0.15;
        ctx.beginPath();
        ctx.moveTo(-s2 * 0.28, -s2 * 1.2); ctx.lineTo(-s2 * 0.55, -s2 * (1.2 - armUp));
        ctx.moveTo(s2 * 0.28, -s2 * 1.2); ctx.lineTo(s2 * 0.55, -s2 * (1.2 - armUp));
        ctx.stroke();
        // Red scarf at the neck.
        ctx.fillStyle = '#d23b3b';
        ctx.fillRect(-s2 * 0.16, -s2 * 1.44, s2 * 0.32, Math.max(1.4, s2 * 0.12));
        // Head.
        ctx.fillStyle = '#e8c9a8';
        ctx.beginPath(); ctx.arc(0, -s2 * 1.62, s2 * 0.19, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(30,30,30,0.6)'; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = INK;
      }});
    });

    q.sort((a, b2) => b2.d - a.d).forEach((o) => o.draw());

    // ── The bull, seen from behind (the photo perspective) ──
    {
      const c = project(cam, b.x, b.y + 0.55, b.z);
      const gp = project(cam, b.x, 0, b.z);
      if (gp) {
        ctx.fillStyle = 'rgba(40,35,25,0.3)';
        const sr = Math.max(7, (cam.f * 1.15) / gp.d);
        ctx.beginPath(); ctx.ellipse(gp.sx, gp.sy, sr, sr * 0.3, 0, 0, Math.PI * 2); ctx.fill();
      }
      if (c) {
        const s2 = Math.max(12, (cam.f * 1.15) / c.d);
        const gallop = Math.sin(b.z * 1.7);
        const flash = b.invulnT > 0 && Math.floor(game.t * 10) % 2 === 0;
        ctx.save();
        ctx.translate(c.sx, c.sy);
        ctx.rotate((LANE_X[b.lane] - b.x) * 0.14);
        ctx.globalAlpha = flash ? 0.45 : 1;
        // Hind legs kicking out to the sides (rear view).
        ctx.strokeStyle = '#141414'; ctx.lineWidth = Math.max(3, s2 * 0.18);
        ctx.beginPath();
        ctx.moveTo(-s2 * 0.42, s2 * 0.2); ctx.lineTo(-s2 * (0.55 + gallop * 0.1), s2 * 0.72);
        ctx.moveTo(s2 * 0.42, s2 * 0.2); ctx.lineTo(s2 * (0.55 - gallop * 0.1), s2 * 0.72);
        ctx.stroke();
        // Front hooves peeking ahead (smaller, higher).
        ctx.lineWidth = Math.max(2.2, s2 * 0.12);
        ctx.beginPath();
        ctx.moveTo(-s2 * 0.2, -s2 * 0.32); ctx.lineTo(-s2 * (0.26 - gallop * 0.06), -s2 * 0.05);
        ctx.moveTo(s2 * 0.2, -s2 * 0.32); ctx.lineTo(s2 * (0.26 + gallop * 0.06), -s2 * 0.05);
        ctx.stroke();
        // Rump — the big dark mass closest to camera.
        ctx.fillStyle = '#111111';
        ctx.beginPath();
        ctx.ellipse(0, s2 * 0.05, s2 * 0.62, s2 * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        // Shoulders/hump — narrower, higher on screen (further away).
        ctx.beginPath();
        ctx.ellipse(0, -s2 * 0.32, s2 * 0.48, s2 * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        // Spine highlight down the back.
        ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = Math.max(1.5, s2 * 0.07);
        ctx.beginPath(); ctx.moveTo(0, s2 * 0.32); ctx.quadraticCurveTo(0, -s2 * 0.05, 0, -s2 * 0.42); ctx.stroke();
        // Head, low between the shoulders.
        ctx.fillStyle = '#0c0c0c';
        ctx.beginPath();
        ctx.ellipse(0, -s2 * 0.56, s2 * 0.22, s2 * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        // Ears flicking out.
        ctx.beginPath();
        ctx.ellipse(-s2 * 0.26, -s2 * 0.58, s2 * 0.08, s2 * 0.045, -0.5, 0, Math.PI * 2);
        ctx.ellipse(s2 * 0.26, -s2 * 0.58, s2 * 0.08, s2 * 0.045, 0.5, 0, Math.PI * 2);
        ctx.fill();
        // The horns: thick white crescents sweeping out and UP — the photo's
        // signature read.
        ctx.strokeStyle = '#f5f2ea'; ctx.lineWidth = Math.max(3, s2 * 0.16); ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-s2 * 0.16, -s2 * 0.6);
        ctx.quadraticCurveTo(-s2 * 0.52, -s2 * 0.68, -s2 * 0.46, -s2 * 0.95);
        ctx.moveTo(s2 * 0.16, -s2 * 0.6);
        ctx.quadraticCurveTo(s2 * 0.52, -s2 * 0.68, s2 * 0.46, -s2 * 0.95);
        ctx.stroke();
        // Horn tips darken.
        ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = Math.max(2, s2 * 0.09);
        ctx.beginPath();
        ctx.moveTo(-s2 * 0.47, -s2 * 0.88); ctx.lineTo(-s2 * 0.46, -s2 * 0.97);
        ctx.moveTo(s2 * 0.47, -s2 * 0.88); ctx.lineTo(s2 * 0.46, -s2 * 0.97);
        ctx.stroke();
        // Tail whipping over the rump.
        ctx.strokeStyle = '#141414'; ctx.lineWidth = Math.max(1.8, s2 * 0.09);
        ctx.beginPath();
        ctx.moveTo(0, s2 * 0.4);
        ctx.quadraticCurveTo(gallop * s2 * 0.3, s2 * 0.75, gallop * s2 * 0.42, s2 * 0.62);
        ctx.stroke();
        ctx.restore();
        // Dust.
        if (b.y === 0 && b.speed > 15) {
          ctx.fillStyle = 'rgba(160,145,110,0.35)';
          for (let d2 = 0; d2 < 3; d2++) {
            const px = c.sx + (d2 - 1) * s2 * 0.4 + boil(d2, tick) * 2;
            ctx.beginPath(); ctx.arc(px, c.sy + s2 * 0.6, s2 * (0.1 + d2 * 0.04), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }

    // ── HUD ──
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(8, 8, 148, 62);
    ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 1; ctx.strokeRect(8, 8, 148, 62);
    ctx.fillStyle = '#c9931a';
    ctx.beginPath(); ctx.arc(22, 24, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a6a1a'; ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = '700 14px ui-monospace, monospace';
    ctx.fillText(`${b.coins}`, 34, 29);
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillText(`${Math.round(b.speed * 3.6)} km/h · ${Math.round(b.z)} m`, 14, 47);
    ctx.fillText(`${b.t.toFixed(1)} s`, 14, 63);
    // Hits: the run's life bar.
    const hitsLeft = MAX_HITS - b.stumbles;
    ctx.font = `700 ${hitsLeft <= 3 ? 17 : 14}px ui-monospace, monospace`;
    ctx.fillStyle = hitsLeft <= 3 ? '#b02a2a' : INK;
    ctx.textAlign = 'right';
    ctx.fillText(`HITS ${b.stumbles}/${MAX_HITS}`, W - 12, 26);
    ctx.textAlign = 'left';
    if (b.z < 30) {
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(game.t * 6);
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.fillStyle = INK;
      ctx.fillText('¡QUE VIENE EL TORO!', W / 2, H * 0.28);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }
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
                An endless street, fresh every run. <span className="mono">←/→</span> cut across
                the lanes, <span className="mono">↑/SPACE</span> jumps barriers and barrels —
                <b> carts can't be jumped</b>. Ten hits ends the run. The deeper you go, the
                faster you charge, the tighter the obstacles, and the thicker the crowd
                blocking your view.
              </p>
              <Btn variant="secondary" onClick={startPractice}><Icon name="bull" size={13} /> Run</Btn>
            </div>
            <div className="card col" style={{ gap: 10, borderColor: 'var(--burn)' }}>
              <Chip tone="burn" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>
                <LiveDot color="var(--burn-ink)" size={5} /> Daily run
              </Chip>
              <b style={{ fontSize: 15 }}>One run · same street for everyone</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Everyone charges today's exact street — same obstacles, same crowd, same
                coin lines, until {status?.hits_limit ?? 10} hits end the run. Most coins
                wins; ties go to the faster bull. <b>One attempt — no restarts.</b> Resets
                00:00 UTC.
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
            ←/→ lanes · ↑/space jump · carts can't be jumped · 10 hits ends the run
          </span>
        </div>
      )}

      {mode === 'done' && result && (
        <div className="card col" style={{ gap: 12 }}>
          <h3 style={{ margin: 0 }}>
            The street won — {MAX_HITS} hits after {Math.round(result.dist)} m.
          </h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Chip tone="ok"><span className="mono">{result.coins} coins · {fmtS(result.ms)}</span></Chip>
            <Chip tone="muted"><span className="mono">{Math.round(result.dist)} m survived</span></Chip>
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
