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
  rocks: { x: number; z: number; r: number }[];
  clouds: { x: number; z: number; y: number; s: number }[];
  /** One winding river: world-space polyline. */
  river: { x: number; z: number }[];
  mountains: { x: number; z: number; h: number; r: number }[];
  regions: { x: number; z: number; name: string }[];
}

/** CoD-style ground-label names; 8 are dealt per map, seed-shuffled. */
export const REGION_NAMES = [
  'TRAIN YARD', 'OLD TOWN', 'QUARRY', 'LUMBERYARD', 'BONEYARD', 'DOCKS',
  'FARMLAND', 'PROMENADE', 'STORAGE TOWN', 'HYDRO', 'SUMMIT', 'SALT FLATS',
];

/** Scenery from a seed — kept clear of the target's inner 60 m. */
export function buildDecor(seed: number, targetX: number, targetZ: number): Decor {
  const rand = mulberry(seed);
  const clear = (x: number, z: number) => Math.hypot(x - targetX, z - targetZ) > 60;
  const trees: Decor['trees'] = [];
  while (trees.length < 110) {
    const x = rand() * MAP_M, z = rand() * MAP_M;
    if (clear(x, z)) trees.push({ x, z, h: 9 + rand() * 8, r: 4 + rand() * 4 });
  }
  const houses: Decor['houses'] = [];
  while (houses.length < 22) {
    const x = MAP_M * 0.1 + rand() * MAP_M * 0.8, z = MAP_M * 0.1 + rand() * MAP_M * 0.8;
    if (clear(x, z)) houses.push({ x, z, w: 12 + rand() * 10, d: 10 + rand() * 8, h: 6 + rand() * 4, rot: rand() * Math.PI });
  }
  const rocks: Decor['rocks'] = [];
  while (rocks.length < 30) {
    const x = rand() * MAP_M, z = rand() * MAP_M;
    if (clear(x, z)) rocks.push({ x, z, r: 1.5 + rand() * 3 });
  }
  const clouds: Decor['clouds'] = [];
  for (let i = 0; i < 12; i++) {
    clouds.push({ x: rand() * MAP_M, z: rand() * MAP_M, y: 350 + rand() * 400, s: 40 + rand() * 70 });
  }
  // River: enters one edge, wanders across to the other side.
  const river: Decor['river'] = [];
  {
    const vertical = rand() < 0.5;
    let off = MAP_M * (0.25 + rand() * 0.5);
    for (let i = 0; i <= 16; i++) {
      const along = (i / 16) * MAP_M;
      off += (rand() - 0.5) * 170;
      off = Math.max(MAP_M * 0.08, Math.min(MAP_M * 0.92, off));
      river.push(vertical ? { x: off, z: along } : { x: along, z: off });
    }
  }
  // Mountain range: a clustered band near one map edge, well clear of the target.
  const mountains: Decor['mountains'] = [];
  {
    const edge = Math.floor(rand() * 4);
    while (mountains.length < 7) {
      const along = MAP_M * (0.08 + rand() * 0.84);
      const depth = MAP_M * (0.04 + rand() * 0.16);
      const [x, z] = edge === 0 ? [along, depth] : edge === 1 ? [along, MAP_M - depth]
        : edge === 2 ? [depth, along] : [MAP_M - depth, along];
      if (Math.hypot(x - targetX, z - targetZ) > 220) {
        mountains.push({ x, z, h: 70 + rand() * 90, r: 90 + rand() * 110 });
      }
    }
  }
  // Regions: 8 seed-shuffled names on a jittered ring around the map.
  const names = [...REGION_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const regions: Decor['regions'] = [];
  for (let i = 0; i < 8; i++) {
    const gx = i % 3, gz = Math.floor(i / 3); // 3×3 grid minus center
    const [cx, cz] = i < 4 ? [gx, gz] : [(i + 1) % 3, Math.floor((i + 1) / 3)];
    regions.push({
      x: MAP_M * (0.18 + cx * 0.32) + (rand() - 0.5) * 160,
      z: MAP_M * (0.18 + cz * 0.32) + (rand() - 0.5) * 160,
      name: names[i],
    });
  }
  return { trees, houses, rocks, clouds, river, mountains, regions };
}

// ── Physics ──
export interface FallState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Canopy currently open (Space toggles — cut and redeploy freely). */
  chute: boolean;
  /** Altitude of the MOST RECENT deploy; the safety check uses this. */
  deployAlt: number | null;
}

export interface FallInput { ax: number; az: number; dive: boolean } // ax/az ∈ [-1,1], world axes

/** One integration step. Returns the state mutated in place (for the loop)
 *  — pure enough to unit-test: no globals, no time source. */
export function stepFall(s: FallState, inp: FallInput, dt: number): FallState {
  const chute = s.chute;
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

/** Landing verdict: safe needs a canopy OPEN at touchdown whose (latest)
 *  deploy happened at/above the floor — cutting away and hitting the ground
 *  in freefall is a crash, and so is a last-second redeploy below 80 m. */
export function landingVerdict(chuteOpen: boolean, deployAlt: number | null): boolean {
  return chuteOpen && deployAlt !== null && deployAlt >= SAFE_DEPLOY_ALT;
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
  // Pitch DOWN by cam.pitch: a point below-forward maps to screen center.
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const ry2 = dy * cp + rz * sp;
  const rz2 = rz * cp - dy * sp;
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
  /** Local replica: the daily drop is replayable without limit. */
  isLocal?: boolean;
}

export default function DropZone({ actor, onGoParticipate, isLocal = false }: DropZoneProps) {
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
    /** Smoothed pose feedback: x = bank (−1..1 with ←/→), y = pitch (↑/↓). */
    lean: { x: number; y: number };
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
      fall: { x: 0, y: PLANE_ALT, z: 0, vx: 0, vy: 0, vz: 0, chute: false, deployAlt: null },
      jumpAt: 0, endAt: 0, daily, runId,
      keys: {}, touch: { ax: 0, az: 0 }, lean: { x: 0, y: 0 }, t: 0,
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
      if (k === ' ' && game.phase === 'fall') toggleChute();
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
      chute: false, deployAlt: null,
    };
    game.jumpAt = game.t;
    game.phase = 'fall';
  };

  /** Space toggles the canopy: deploy ↔ cut, unlimited chutes. Only the
   *  state at touchdown matters (open + last deploy ≥ 80 m). */
  const toggleChute = () => {
    const game = g.current;
    if (!game || game.phase !== 'fall') return;
    if (game.fall.chute) {
      game.fall.chute = false; // cut away — back to freefall
    } else {
      game.fall.chute = true;
      game.fall.deployAlt = game.fall.y;
    }
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
        // Camera-relative basis: screen-forward = (hx, hz); screen-RIGHT is
        // (hz, −hx) under this projection (rx = dx·hz − dz·hx).
        const ax = path.hx * fwd + path.hz * side + game.touch.ax;
        const az = path.hz * fwd - path.hx * side + game.touch.az;
        const n = Math.hypot(ax, az) || 1;
        game.lean.x += (side - game.lean.x) * Math.min(1, dt * 8);
        game.lean.y += (fwd - game.lean.y) * Math.min(1, dt * 8);
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
        const safe = landingVerdict(game.fall.chute, game.fall.deployAlt);
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

  // ── Renderer: grayscale ink — tonal fills, contact shadows, hatching ──
  const INK = '#1a1a1a';
  const draw = (ctx: CanvasRenderingContext2D, W: number, H: number, game: NonNullable<typeof g.current>) => {
    const tick = Math.floor(game.t * 5); // line-boil clock
    const path = planePath(game.scenario.planeDir);
    const yaw = Math.atan2(path.hx, path.hz);
    const inPlane = game.phase === 'plane';
    const p = game.fall;
    const pitch = inPlane ? 0.55 : Math.min(1.15, 0.55 + (1 - p.y / PLANE_ALT) * 0.35);
    const back = inPlane ? 90 : 60;
    const cam: Cam = {
      x: p.x - path.hx * back, y: p.y + (inPlane ? 40 : 55), z: p.z - path.hz * back,
      yaw, pitch, f: H * 0.9, w: W, h: H,
    };

    // Sky gradient → haze band → ground tone.
    const horizon = project(cam, cam.x + path.hx * 6000, 0, cam.z + path.hz * 6000);
    const hy = Math.max(0, Math.min(H, horizon ? horizon.sy : 0));
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
    sky.addColorStop(0, '#7fb2dd');
    sky.addColorStop(1, '#dceefa');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hy);
    const ground = ctx.createLinearGradient(0, hy, 0, H);
    ground.addColorStop(0, '#dcdcd8');
    ground.addColorStop(1, '#eceae4');
    ctx.fillStyle = ground;
    ctx.fillRect(0, hy, W, H - hy);
    ctx.strokeStyle = '#8a8a8a';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
    // Distant haze band under the horizon.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(0, hy, W, 14);
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';

    // Painter's queue for world objects.
    const q: { d: number; draw: () => void }[] = [];
    const groundShadow = (wx: number, wz: number, r: number, d: number) => {
      q.push({ d: d + 0.5, draw: () => {
        const c0 = project(cam, wx, 0, wz);
        const c1 = project(cam, wx + r, 0, wz);
        if (!c0 || !c1) return;
        const rr = Math.abs(c1.sx - c0.sx);
        ctx.fillStyle = 'rgba(70,70,70,0.25)';
        ctx.beginPath(); ctx.ellipse(c0.sx + rr * 0.35, c0.sy, rr, rr * 0.32, 0, 0, Math.PI * 2); ctx.fill();
      }});
    };

    // Field patches: tonal fills + hatch (the countryside quilt).
    const fr = mulberry(game.scenario.decorSeed ^ 0x5eed);
    for (let i = 0; i < 22; i++) {
      const fx = fr() * MAP_M, fz = fr() * MAP_M, fs = 90 + fr() * 200, ang = fr() * Math.PI;
      const tone = 0.10 + fr() * 0.14;
      const hueRoll = fr();
      const patchColor = hueRoll < 0.45 ? '96,140,66' : hueRoll < 0.8 ? '180,158,72' : '110,110,100';
      const c = project(cam, fx, 0, fz);
      if (!c) continue;
      q.push({ d: c.d + 2, draw: () => {
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const pts = [[-1, -0.7], [1, -0.7], [1, 0.7], [-1, 0.7]].map(([u, v]) =>
          project(cam, fx + (u * cs - v * sn) * fs, 0, fz + (u * sn + v * cs) * fs));
        if (pts.some((pt) => !pt)) return;
        const P = pts as NonNullable<(typeof pts)[0]>[];
        ctx.beginPath();
        P.forEach((pt, k) => (k === 0 ? ctx.moveTo(pt.sx, pt.sy) : ctx.lineTo(pt.sx, pt.sy)));
        ctx.closePath();
        ctx.fillStyle = `rgba(${patchColor},${tone})`;
        ctx.fill();
        ctx.save(); ctx.clip();
        ctx.strokeStyle = `rgba(${patchColor},0.55)`; ctx.lineWidth = 0.8;
        const minx = Math.min(...P.map((t) => t.sx)), maxx = Math.max(...P.map((t) => t.sx));
        const miny = Math.min(...P.map((t) => t.sy)), maxy = Math.max(...P.map((t) => t.sy));
        for (let x = minx - (maxy - miny); x < maxx; x += 6) {
          ctx.beginPath(); ctx.moveTo(x, miny); ctx.lineTo(x + (maxy - miny), maxy); ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = INK;
      }});
    }

    // River: layered blue strokes along the polyline, width by depth.
    {
      const rv = game.decor.river;
      const c0 = project(cam, rv[Math.floor(rv.length / 2)].x, 0, rv[Math.floor(rv.length / 2)].z);
      if (c0) q.push({ d: c0.d + 1.8, draw: () => {
        const pass = (widthM: number, color: string) => {
          ctx.strokeStyle = color; ctx.lineJoin = 'round';
          for (let i = 0; i < rv.length - 1; i++) {
            const a = project(cam, rv[i].x, 0, rv[i].z);
            const b = project(cam, rv[i + 1].x, 0, rv[i + 1].z);
            if (!a || !b) continue;
            ctx.lineWidth = Math.max(1.2, (cam.f * widthM) / ((a.d + b.d) / 2));
            ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
          }
        };
        pass(22, '#3c6f9c');
        pass(15, '#5f9cc9');
        pass(4, 'rgba(240,248,255,0.7)'); // glint
        ctx.strokeStyle = INK;
      }});
    }

    // Two dirt roads crossing the map (gray double strokes).
    for (let r = 0; r < 2; r++) {
      const off = MAP_M * (0.3 + r * 0.4);
      const c = project(cam, off, 0, MAP_M / 2);
      if (!c) continue;
      q.push({ d: c.d + 1.5, draw: () => {
        ctx.strokeStyle = '#9a9a94'; ctx.lineWidth = r === 0 ? 5 : 4; ctx.globalAlpha = 0.75;
        ctx.beginPath();
        for (let seg = 0; seg <= 20; seg++) {
          const tt = seg / 20;
          const wig = Math.sin(tt * 6 + r * 3) * 60;
          const pt = r === 0
            ? project(cam, off + wig, 0, tt * MAP_M)
            : project(cam, tt * MAP_M, 0, off + wig);
          if (!pt) continue;
          seg === 0 ? ctx.moveTo(pt.sx, pt.sy) : ctx.lineTo(pt.sx, pt.sy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1; ctx.strokeStyle = INK;
      }});
    }

    // Mountains: faceted peaks, rock-blue faces, white snow caps.
    game.decor.mountains.forEach((mt, i) => {
      const base = project(cam, mt.x, 0, mt.z);
      if (!base) return;
      q.push({ d: base.d, draw: () => {
        const apex = project(cam, mt.x, mt.h, mt.z);
        if (!apex) return;
        const ring: { sx: number; sy: number }[] = [];
        for (let a = 0; a < 6; a++) {
          const th = (a / 6) * Math.PI * 2 + i;
          const wob = 1 + 0.25 * Math.sin(a * 2.4 + i * 3);
          const pt = project(cam, mt.x + Math.cos(th) * mt.r * wob, 0, mt.z + Math.sin(th) * mt.r * wob);
          if (pt) ring.push(pt);
        }
        if (ring.length < 4) return;
        for (let a = 0; a < ring.length; a++) {
          const b = (a + 1) % ring.length;
          ctx.beginPath();
          ctx.moveTo(ring[a].sx, ring[a].sy); ctx.lineTo(ring[b].sx, ring[b].sy); ctx.lineTo(apex.sx, apex.sy);
          ctx.closePath();
          ctx.fillStyle = a % 2 === 0 ? '#8d99a6' : '#75828f';
          ctx.fill();
          ctx.strokeStyle = '#3a4148'; ctx.lineWidth = 1.3; ctx.stroke();
        }
        // Snow cap: upper third of every face.
        for (let a = 0; a < ring.length; a++) {
          const b = (a + 1) % ring.length;
          const ma = { sx: ring[a].sx + (apex.sx - ring[a].sx) * 0.62, sy: ring[a].sy + (apex.sy - ring[a].sy) * 0.62 };
          const mb = { sx: ring[b].sx + (apex.sx - ring[b].sx) * 0.62, sy: ring[b].sy + (apex.sy - ring[b].sy) * 0.62 };
          ctx.beginPath();
          ctx.moveTo(ma.sx, ma.sy); ctx.lineTo(mb.sx, mb.sy); ctx.lineTo(apex.sx, apex.sy);
          ctx.closePath();
          ctx.fillStyle = a % 2 === 0 ? '#fbfbfb' : '#e9edf1';
          ctx.fill();
          ctx.strokeStyle = '#9aa4ad'; ctx.lineWidth = 0.9; ctx.stroke();
        }
        ctx.strokeStyle = INK;
      }});
    });

    // Target: filled alternating bullseye + flag.
    {
      const sc = game.scenario;
      const c = project(cam, sc.targetX, 0, sc.targetZ);
      if (c) q.push({ d: c.d, draw: () => {
        const ring = (r: number, fill: string) => {
          ctx.beginPath();
          for (let a = 0; a <= 36; a++) {
            const th = (a / 36) * Math.PI * 2;
            const pt = project(cam, sc.targetX + Math.cos(th) * r, 0, sc.targetZ + Math.sin(th) * r);
            if (pt) { const j = boil(r * 3 + a, tick) * 0.6; a === 0 ? ctx.moveTo(pt.sx + j, pt.sy) : ctx.lineTo(pt.sx + j, pt.sy); }
          }
          ctx.closePath();
          ctx.fillStyle = fill; ctx.fill();
          ctx.strokeStyle = INK; ctx.lineWidth = 1.8; ctx.stroke();
        };
        ring(TARGET_RINGS_M[2], '#e05252');
        ring(TARGET_RINGS_M[1], '#f7f7f4');
        ring(TARGET_RINGS_M[0], '#b02a2a');
        const top = project(cam, sc.targetX, 16, sc.targetZ);
        if (top) {
          ctx.lineWidth = 2.4;
          ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
          ctx.fillStyle = '#c93b3b';
          ctx.beginPath(); ctx.moveTo(top.sx, top.sy); ctx.lineTo(top.sx + 22, top.sy + 6); ctx.lineTo(top.sx, top.sy + 12); ctx.closePath(); ctx.fill();
        }
      }});
    }

    // Rocks: small gray lumps.
    game.decor.rocks.forEach((rk, i) => {
      const base = project(cam, rk.x, 0, rk.z);
      if (!base || base.d > 1200) return;
      q.push({ d: base.d, draw: () => {
        const rr = Math.max(1.5, (cam.f * rk.r) / base.d);
        ctx.fillStyle = '#a8a8a2';
        ctx.beginPath();
        for (let a = 0; a <= 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          const px = base.sx + Math.cos(th) * rr * (1 + 0.3 * Math.sin(a * 3 + i));
          const py = base.sy + Math.sin(th) * rr * 0.55;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#6d6d6d'; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = INK;
      }});
    });

    // Trees: contact shadow, dark trunk, tonal scribble canopy.
    game.decor.trees.forEach((t, i) => {
      const base = project(cam, t.x, 0, t.z);
      if (!base || base.d > 1800) return;
      groundShadow(t.x, t.z, t.r * 1.1, base.d);
      q.push({ d: base.d, draw: () => {
        const top = project(cam, t.x, t.h, t.z);
        if (!top) return;
        ctx.strokeStyle = '#3c3c3c'; ctx.lineWidth = Math.max(1.4, (cam.f * 0.8) / base.d);
        ctx.beginPath(); ctx.moveTo(base.sx, base.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
        const rr = Math.max(2.5, (cam.f * t.r) / base.d);
        ctx.beginPath();
        for (let a = 0; a <= 16; a++) {
          const th = (a / 16) * Math.PI * 2;
          const j = boil(i * 17 + a, tick);
          const bump = 1 + 0.18 * Math.sin(a * 2.3 + i);
          const px = top.sx + Math.cos(th) * (rr * bump + j), py = top.sy + Math.sin(th) * (rr * 0.85 * bump + j);
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = i % 3 === 0 ? '#5f9e63' : '#7cb877';
        ctx.fill();
        ctx.strokeStyle = '#2e2e2e'; ctx.lineWidth = 1.5; ctx.stroke();
        // Canopy hatch scribbles.
        ctx.strokeStyle = 'rgba(25,70,30,0.45)'; ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(top.sx - rr * 0.5, top.sy + rr * 0.2); ctx.lineTo(top.sx + rr * 0.1, top.sy - rr * 0.4);
        ctx.moveTo(top.sx - rr * 0.1, top.sy + rr * 0.5); ctx.lineTo(top.sx + rr * 0.5, top.sy - rr * 0.1);
        ctx.stroke();
        ctx.strokeStyle = INK;
      }});
    });

    // Houses: contact shadow, two-tone walls, dark hatched roof.
    game.decor.houses.forEach((hs, i) => {
      const base = project(cam, hs.x, 0, hs.z);
      if (!base || base.d > 1800) return;
      groundShadow(hs.x, hs.z, Math.max(hs.w, hs.d) * 0.8, base.d);
      q.push({ d: base.d, draw: () => {
        const cs = Math.cos(hs.rot), sn = Math.sin(hs.rot);
        const cnr = (dx: number, dz: number, y: number) =>
          project(cam, hs.x + dx * cs - dz * sn, y, hs.z + dx * sn + dz * cs);
        const w2 = hs.w / 2, d2 = hs.d / 2;
        const pts = [cnr(-w2, -d2, 0), cnr(w2, -d2, 0), cnr(w2, d2, 0), cnr(-w2, d2, 0),
                     cnr(-w2, -d2, hs.h), cnr(w2, -d2, hs.h), cnr(w2, d2, hs.h), cnr(-w2, d2, hs.h),
                     cnr(0, -d2, hs.h + 4.5), cnr(0, d2, hs.h + 4.5)];
        if (pts.some((pt) => !pt)) return;
        const P = pts as NonNullable<(typeof pts)[0]>[];
        const poly = (ids: number[], fill: string, hatch = false) => {
          ctx.beginPath();
          ids.forEach((id, k) => {
            const j = boil(i * 31 + id, tick) * 0.7;
            k === 0 ? ctx.moveTo(P[id].sx + j, P[id].sy) : ctx.lineTo(P[id].sx + j, P[id].sy);
          });
          ctx.closePath();
          ctx.fillStyle = fill; ctx.fill();
          ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1.5; ctx.stroke();
          if (hatch) {
            ctx.save(); ctx.clip();
            ctx.strokeStyle = 'rgba(30,30,30,0.55)'; ctx.lineWidth = 0.8;
            const minx = Math.min(...ids.map((id) => P[id].sx)), maxx = Math.max(...ids.map((id) => P[id].sx));
            const miny = Math.min(...ids.map((id) => P[id].sy)), maxy = Math.max(...ids.map((id) => P[id].sy));
            for (let x = minx - (maxy - miny); x < maxx; x += 4.5) {
              ctx.beginPath(); ctx.moveTo(x, miny); ctx.lineTo(x + (maxy - miny), maxy); ctx.stroke();
            }
            ctx.restore();
          }
        };
        poly([0, 1, 5, 4], '#e8e8e2');           // lit wall
        poly([1, 2, 6, 5], '#c4c4bc');           // shaded wall
        poly([4, 5, 8], '#a2604a', true);        // gable
        poly([5, 6, 9, 8], '#8f4f3c', true);     // roof plane
        // Door + window on the lit wall.
        const mid = (a: number, b: number, f2: number) => ({ sx: P[a].sx + (P[b].sx - P[a].sx) * f2, sy: P[a].sy + (P[b].sy - P[a].sy) * f2 });
        const dpos = mid(0, 1, 0.28), dtop = mid(4, 5, 0.28);
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(dpos.sx - 2, dpos.sy - (dpos.sy - dtop.sy) * 0.55, 4.5, (dpos.sy - dtop.sy) * 0.55);
        const wpos = mid(0, 1, 0.68), wtop = mid(4, 5, 0.68);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(wpos.sx - 2.5, wpos.sy - (wpos.sy - wtop.sy) * 0.7, 5, (wpos.sy - wtop.sy) * 0.34);
        ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 0.8;
        ctx.strokeRect(wpos.sx - 2.5, wpos.sy - (wpos.sy - wtop.sy) * 0.7, 5, (wpos.sy - wtop.sy) * 0.34);
        ctx.strokeStyle = INK;
      }});
    });

    // Clouds: soft gray fills with darker underside line.
    game.decor.clouds.forEach((cl, i) => {
      const c = project(cam, cl.x, cl.y, cl.z);
      if (!c) return;
      q.push({ d: c.d, draw: () => {
        const r = (cam.f * cl.s) / c.d;
        if (r < 3) return;
        ctx.beginPath();
        for (let a = 0; a <= 18; a++) {
          const th = (a / 18) * Math.PI * 2;
          const bump = 1 + 0.26 * Math.sin(a * 2.7 + i);
          const j = boil(i * 23 + a, tick);
          const px = c.sx + Math.cos(th) * (r * bump + j), py = c.sy + Math.sin(th) * (r * 0.42 * bump + j);
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(246,246,246,0.94)'; ctx.fill();
        ctx.strokeStyle = '#909090'; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.strokeStyle = '#787878'; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(c.sx - r * 0.7, c.sy + r * 0.34); ctx.quadraticCurveTo(c.sx, c.sy + r * 0.52, c.sx + r * 0.7, c.sy + r * 0.34); ctx.stroke();
        ctx.strokeStyle = INK;
      }});
    });

    q.sort((a, b) => b.d - a.d).forEach((o) => o.draw());

    // Region names — floating ground labels, Warzone-style.
    ctx.textAlign = 'center';
    game.decor.regions.forEach((rg) => {
      const c = project(cam, rg.x, 2, rg.z);
      if (!c || c.d > 2600) return;
      const size = Math.max(9, Math.min(20, (cam.f * 26) / c.d));
      const fade = Math.max(0.25, Math.min(0.85, 1.6 - c.d / 1800));
      ctx.font = `700 ${size}px ui-monospace, monospace`;
      ctx.globalAlpha = fade;
      ctx.lineWidth = Math.max(2, size / 5);
      ctx.strokeStyle = 'rgba(40,44,48,0.9)';
      ctx.strokeText(rg.name, c.sx, c.sy);
      ctx.fillStyle = 'rgba(252,250,244,0.95)';
      ctx.fillText(rg.name, c.sx, c.sy);
      ctx.globalAlpha = 1;
    });
    ctx.textAlign = 'left';
    ctx.strokeStyle = INK;

    // ── The plane / the jumper (drawn last — always on top) ──
    if (inPlane) {
      const c = project(cam, p.x, PLANE_ALT, p.z);
      if (c) {
        ctx.save();
        ctx.translate(c.sx, c.sy);
        const bob = Math.sin(game.t * 1.7) * 2; // gentle float
        ctx.translate(0, bob);
        ctx.strokeStyle = INK; ctx.lineWidth = 2;
        // Swept wings (rear view): from the shoulder out and slightly up.
        ctx.fillStyle = '#3d4046';
        ctx.beginPath();
        ctx.moveTo(-8, -6);
        ctx.lineTo(-96, -22); ctx.lineTo(-96, -15); ctx.lineTo(-10, 2);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(8, -6);
        ctx.lineTo(96, -22); ctx.lineTo(96, -15); ctx.lineTo(10, 2);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        // Wingtip lights: red port, green starboard.
        ctx.fillStyle = '#d23b3b'; ctx.beginPath(); ctx.arc(-95, -19, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#3fae5a'; ctx.beginPath(); ctx.arc(95, -19, 2.6, 0, Math.PI * 2); ctx.fill();
        // Engine pods under each wing.
        ctx.fillStyle = '#2c2f34';
        for (const ex of [-52, -30, 30, 52]) {
          ctx.beginPath(); ctx.ellipse(ex, -8, 6, 7.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#15171a';
          ctx.beginPath(); ctx.ellipse(ex, -8, 3, 4.5, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#2c2f34';
        }
        // Fuselage: rear disc + taper.
        ctx.fillStyle = '#464a51';
        ctx.beginPath(); ctx.ellipse(0, -2, 13, 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#33363b';
        ctx.beginPath(); ctx.ellipse(0, -2, 8, 10, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // Open rear ramp glow.
        ctx.fillStyle = '#0e0f11';
        ctx.fillRect(-5, 2, 10, 9);
        // Tail: tall fin + horizontal stabilizers.
        ctx.fillStyle = '#3d4046';
        ctx.beginPath(); ctx.moveTo(-2.5, -14); ctx.lineTo(-2.5, -44); ctx.lineTo(4.5, -44); ctx.lineTo(2.5, -14); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-34, -38); ctx.lineTo(34, -38); ctx.lineTo(26, -33); ctx.lineTo(-26, -33); ctx.closePath(); ctx.fill(); ctx.stroke();
        // Tail beacon.
        ctx.fillStyle = (Math.floor(game.t * 2) % 2 === 0) ? '#d23b3b' : '#6b2020';
        ctx.beginPath(); ctx.arc(1, -46, 2.4, 0, Math.PI * 2); ctx.fill();
        // Contrails off the wingtips.
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 3;
        for (const wx of [-95, 95]) {
          ctx.beginPath(); ctx.moveTo(wx, -18); ctx.quadraticCurveTo(wx * 1.06, -10, wx * 1.12, 26); ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = INK;
      }
    } else {
      const c = project(cam, p.x, p.y, p.z);
      // Landing marker: dashed drop-line + ground ring right below the player.
      const gpt = project(cam, p.x, 0, p.z);
      if (c && gpt && game.phase === 'fall') {
        ctx.save();
        ctx.strokeStyle = '#5a5a5a'; ctx.lineWidth = 1.4; ctx.setLineDash([6, 7]);
        ctx.beginPath(); ctx.moveTo(c.sx, c.sy + 24); ctx.lineTo(gpt.sx, gpt.sy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.ellipse(gpt.sx, gpt.sy, 9, 3.4, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (c) {
        const chute = p.chute;
        const dive = game.keys['shift'] && !chute;
        ctx.save();
        // Pose feedback: ↑ lifts up to half a body length, ↓ dips; ←/→ bank.
        ctx.translate(c.sx, c.sy - game.lean.y * 11);
        ctx.rotate(game.lean.x * 0.34);
        ctx.strokeStyle = INK;
        if (chute) {
          // Canopy: gray fill, rib lines, shroud lines.
          ctx.lineWidth = 2.2;
          ctx.fillStyle = '#c8c8c0';
          ctx.beginPath(); ctx.arc(0, -34, 27, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.lineWidth = 1.2; ctx.strokeStyle = '#5a5a5a';
          for (let rb = -1; rb <= 1; rb++) {
            ctx.beginPath(); ctx.moveTo(rb * 13, -34); ctx.quadraticCurveTo(rb * 13, -52, 0, -60.5); ctx.stroke();
          }
          ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(-25, -31); ctx.lineTo(0, -2);
          ctx.moveTo(25, -31); ctx.lineTo(0, -2);
          ctx.moveTo(-9, -34); ctx.lineTo(0, -2);
          ctx.moveTo(9, -34); ctx.lineTo(0, -2);
          ctx.stroke();
        }
        // Jumper: filled body, big enough to READ.
        ctx.fillStyle = '#222';
        ctx.beginPath(); ctx.arc(0, chute ? 2 : -6, 5, 0, Math.PI * 2); ctx.fill(); // head
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.moveTo(0, chute ? 6 : -2); ctx.lineTo(0, chute ? 20 : 12); // torso
        const spread = dive ? 4 : 12;
        const yArm = chute ? 9 : 1, yHand = chute ? -1 : (dive ? 13 : -6);
        ctx.moveTo(-spread, yHand); ctx.lineTo(0, yArm); ctx.lineTo(spread, yHand); // arms
        const yHip = chute ? 20 : 12, yFoot = chute ? 32 : (dive ? 26 : 20);
        ctx.moveTo(-spread * 0.8, yFoot); ctx.lineTo(0, yHip); ctx.lineTo(spread * 0.8, yFoot); // legs
        ctx.stroke();
        ctx.restore();
        // Dive speed lines — the anime touch.
        if (dive) {
          ctx.save(); ctx.globalAlpha = 0.45; ctx.lineWidth = 1.6; ctx.strokeStyle = '#3a3a3a';
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2 + boil(i, tick) * 0.2;
            const r1 = Math.min(W, H) * 0.38, r2 = r1 + 34 + boil(i + 50, tick) * 8;
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
    ctx.fillStyle = INK;
    ctx.font = '600 13px ui-monospace, monospace';
    const dist = distanceToTarget(p.x, p.z, game.scenario);
    if (inPlane) {
      ctx.textAlign = 'center';
      const pulse = 0.6 + 0.4 * Math.sin(game.t * 5);
      ctx.globalAlpha = pulse;
      ctx.font = '700 24px ui-monospace, monospace';
      ctx.fillText('press J to JUMP', W / 2, H * 0.14);
      ctx.globalAlpha = 1;
      ctx.font = '600 13px ui-monospace, monospace';
      ctx.fillText(`target ${Math.round(dist)} m ${dist < 320 ? '— NOW!' : ''}`, W / 2, H * 0.14 + 22);
      ctx.textAlign = 'left';
    } else {
      // HUD plate so the numbers read over any terrain.
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillRect(8, 8, 128, 76);
      ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 1; ctx.strokeRect(8, 8, 128, 76);
      ctx.fillStyle = INK;
      ctx.fillText(`ALT    ${Math.max(0, Math.round(p.y))} m`, 14, 24);
      ctx.fillText(`SINK   ${Math.round(p.vy)} m/s`, 14, 42);
      ctx.fillText(`TARGET ${Math.round(dist)} m`, 14, 60);
      ctx.fillText(`T      ${(game.t - game.jumpAt).toFixed(1)} s`, 14, 78);
      // Altimeter with the 80 m floor marked.
      const ax = W - 26, ah = H * 0.6, ay = H * 0.2;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillRect(ax - 2, ay - 2, 14, ah + 4);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
      ctx.strokeRect(ax, ay, 10, ah);
      const floorY = ay + ah * (1 - SAFE_DEPLOY_ALT / PLANE_ALT);
      ctx.strokeStyle = '#555';
      ctx.beginPath(); ctx.moveTo(ax - 5, floorY); ctx.lineTo(ax + 15, floorY); ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.fillStyle = p.chute ? '#777' : INK;
      ctx.fillRect(ax, ay + ah * (1 - Math.max(0, p.y) / PLANE_ALT) - 2.5, 10, 5);
      if (!p.chute && p.y < SAFE_DEPLOY_ALT * 2.2 && game.phase === 'fall') {
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.65 + 0.35 * Math.sin(game.t * 9);
        ctx.font = '700 22px ui-monospace, monospace';
        ctx.fillStyle = p.y >= SAFE_DEPLOY_ALT ? INK : '#b02a2a';
        ctx.fillText(p.y >= SAFE_DEPLOY_ALT ? 'SPACE — DEPLOY!' : 'TOO LOW…', W / 2, H * 0.12);
        ctx.fillStyle = INK;
        ctx.globalAlpha = 1;
        ctx.textAlign = 'left';
        ctx.font = '600 13px ui-monospace, monospace';
      }
    }

    // ── Minimap ──
    const ms = Math.min(130, W * 0.24), mx = 12, my = H - ms - 12;
    ctx.fillStyle = 'rgba(250,250,248,0.9)';
    ctx.fillRect(mx, my, ms, ms);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.6; ctx.strokeRect(mx, my, ms, ms);
    const mm = (wx: number, wz: number) => ({ x: mx + (wx / MAP_M) * ms, y: my + (wz / MAP_M) * ms });
    // Scenery so the minimap reads as the terrain.
    ctx.strokeStyle = '#5f9cc9'; ctx.lineWidth = 1.8;
    ctx.beginPath();
    game.decor.river.forEach((pt, i) => {
      const q2 = mm(pt.x, pt.z);
      i === 0 ? ctx.moveTo(q2.x, q2.y) : ctx.lineTo(q2.x, q2.y);
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(120,130,143,0.8)';
    game.decor.mountains.forEach((mt) => {
      const pt = mm(mt.x, mt.z);
      ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 4); ctx.lineTo(pt.x - 3.5, pt.y + 2.5); ctx.lineTo(pt.x + 3.5, pt.y + 2.5); ctx.closePath(); ctx.fill();
    });
    ctx.fillStyle = 'rgba(90,90,90,0.4)';
    game.decor.houses.forEach((hs) => { const pt = mm(hs.x, hs.z); ctx.fillRect(pt.x - 1.5, pt.y - 1.5, 3, 3); });
    const tg = mm(game.scenario.targetX, game.scenario.targetZ);
    ctx.strokeStyle = '#c93b3b'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(tg.x - 5, tg.y - 5); ctx.lineTo(tg.x + 5, tg.y + 5); ctx.moveTo(tg.x + 5, tg.y - 5); ctx.lineTo(tg.x - 5, tg.y + 5); ctx.stroke();
    ctx.strokeStyle = INK;
    const me = mm(p.x, p.z);
    ctx.fillStyle = INK;
    if (inPlane) {
      ctx.save(); ctx.translate(me.x, me.y); ctx.rotate(Math.atan2(path.hz, path.hx));
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -4.5); ctx.lineTo(-6, 4.5); ctx.closePath(); ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(me.x, me.y, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#777'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(me.x, me.y, 6.5, 0, Math.PI * 2); ctx.stroke();
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
    game.touch.ax = path.hx * fwd + path.hz * side;
    game.touch.az = path.hz * fwd - path.hx * side;
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
                (fast fall, weak steering), <span className="mono">SPACE</span> toggles the chute —
                pop it, cut it, pop it again, as often as you like. Just land with a canopy
                that opened above <b>80 m</b> or you crater. Early chute = long glide; cutting
                trades safety margin for speed.
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
              ) : status?.played && !isLocal ? (
                <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                  <Icon name="checkCircle" size={11} /> Jumped today{status.my_entry ? ` — ${(status.my_entry.distance_dm / 10).toFixed(1)} m ${status.my_entry.safe ? '' : '· crashed'}` : ''}
                </Chip>
              ) : (
                <div className="col" style={{ gap: 6 }}>
                  <Btn variant="primary" disabled={busy || !status} onClick={startDaily}>
                    {busy ? <LiveDot size={8} /> : <Icon name="parachute" size={13} stroke="var(--char-950)" />} Board the plane
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
            <Btn variant="primary" sm onClick={toggleChute} style={{ minWidth: 110, minHeight: 44 }}>SPACE · CHUTE/CUT</Btn>
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
