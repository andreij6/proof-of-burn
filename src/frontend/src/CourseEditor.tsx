import { useEffect, useMemo, useRef, useState } from 'react';
import type { Identity } from '@icp-sdk/core/agent';
import { Icon, Eyebrow, Chip, Btn, MoreInfo } from './ui';
import { createActor as createLedgerActor } from './bindings/ledger';
import { fmtICP } from './ui';
import MiniGolf from './arcade/MiniGolf';
import {
  holeFromCourseData, CELL,
  type HoleDef, type CharacterLook, type Vec,
} from './arcade/engine';
import {
  type CourseDataV1, type Hole, type Element, type Theme,
  ElementKind as EK, LIMITS, encodeCourseData,
} from './arcade/courseData';
import {
  emptyCourse, holeStatus, mintGate, parTotal, defaultParams, elementAt,
  placeElement, deleteElementAt, rotateElement,
} from './arcade/courseEditorLogic';
import { difficultyBucket } from './arcade/courseMarket';
import { activeRenderKit, type Renderer, type ElementView } from './arcade/renderKit';

// ==========================================
// Course NFT Editor (PB-302) — per-user 9-hole builder producing a CourseDataV1
// blob destined to become an NFT. Three rows: name + actions; horizontal hole
// selector; a 3-pane build row (palette · editable map · live preview). There
// is no draft persistence — leaving with in-progress work confirms first. The
// Mint flow encodes the course, fetches the escrow deposit address, transfers
// 0.5 ICP, and calls mint_course_nft (PB-304).
//
// NOTE: This is a NEW, standalone component. The legacy admin paint editor
// (arcade/CourseEditor.tsx) is intentionally untouched (spec D4).
// ==========================================

const MINT_FEE_E8S = 50_000_000n; // 0.5 ICP
const ICP_FEE_E8S = 10_000n;

interface CourseEditorProps {
  actor: any;
  identity: Identity | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  character: CharacterLook | null;
  /** After a successful mint, route to the new listing (token id passed). */
  onMinted: (tokenId: bigint) => void;
  onExit: () => void;
}

// ── Palette catalog: groups → kinds present in the courseData element catalog. ──
const PALETTE: { group: string; items: { kind: number; label: string }[] }[] = [
  { group: 'Required', items: [
    { kind: -1, label: 'Tee' }, { kind: -2, label: 'Cup' },
  ] },
  { group: 'Terrain', items: [
    { kind: EK.Fairway, label: 'Fairway' }, { kind: EK.Rough, label: 'Rough' },
    { kind: EK.Sand, label: 'Sand' }, { kind: EK.Water, label: 'Water' },
    { kind: EK.OutOfBounds, label: 'Out of bounds' },
  ] },
  { group: 'Walls', items: [
    { kind: EK.WallStraight, label: 'Straight' }, { kind: EK.WallCorner, label: 'Corner' },
    { kind: EK.WallAngled45, label: 'Angled 45°' }, { kind: EK.WallCurved, label: 'Curved' },
  ] },
  { group: 'Obstacles', items: [
    { kind: EK.Rock, label: 'Rock' }, { kind: EK.Pillar, label: 'Pillar' },
    { kind: EK.Bumper, label: 'Bumper' }, { kind: EK.Tree, label: 'Tree' },
  ] },
  { group: 'Moving', items: [
    { kind: EK.Windmill, label: 'Windmill' }, { kind: EK.Pendulum, label: 'Pendulum' },
    { kind: EK.RotatingPaddle, label: 'Paddle' }, { kind: EK.SlidingBlock, label: 'Sliding block' },
  ] },
  { group: 'Special', items: [
    { kind: EK.TunnelEntrance, label: 'Tunnel in' }, { kind: EK.TunnelExit, label: 'Tunnel out' },
    { kind: EK.RampUp, label: 'Ramp up' }, { kind: EK.RampDown, label: 'Ramp down' },
    { kind: EK.SpeedTile, label: 'Speed tile' }, { kind: EK.SlowTile, label: 'Slow tile' },
  ] },
];

// Tee/Cup are armed via sentinel kinds (they live on Hole, not as elements).
const ARM_TEE = -1;
const ARM_CUP = -2;

const ELEMENT_GLYPH: Record<number, string> = {
  [EK.Fairway]: '·', [EK.Rough]: '"', [EK.Sand]: '∴', [EK.Water]: '≈', [EK.OutOfBounds]: '✕',
  [EK.WallStraight]: '│', [EK.WallCorner]: '┐', [EK.WallAngled45]: '╱', [EK.WallCurved]: '◜',
  [EK.Rock]: '◆', [EK.Pillar]: '●', [EK.Bumper]: '◉', [EK.Tree]: '♣',
  [EK.Windmill]: '✦', [EK.Pendulum]: '⊙', [EK.RotatingPaddle]: '✚', [EK.SlidingBlock]: '▭',
  [EK.TunnelEntrance]: '◐', [EK.TunnelExit]: '◑', [EK.RampUp]: '▲', [EK.RampDown]: '▼',
  [EK.SpeedTile]: '»', [EK.SlowTile]: '«',
};

export default function CourseEditor({
  actor, identity, host, rootKey, ledgerCanisterId, character, onMinted, onExit,
}: CourseEditorProps) {
  const [course, setCourse] = useState<CourseDataV1>(emptyCourse);
  const [name, setName] = useState('');
  const [activeHole, setActiveHole] = useState(0);
  const [armed, setArmed] = useState<number | null>(null); // palette kind, or null = select mode
  const [selected, setSelected] = useState<number | null>(null); // element index in active hole
  const [touched, setTouched] = useState<boolean[]>(() => Array(LIMITS.HOLES).fill(false));
  const [playtest, setPlaytest] = useState<HoleDef | null>(null);
  const [showMint, setShowMint] = useState(false);

  const nextPairIdRef = useRef(0);

  const hole = course.holes[activeHole];

  const updateHole = (idx: number, patch: Partial<Hole>) => {
    setCourse((c) => ({ ...c, holes: c.holes.map((h, i) => (i === idx ? { ...h, ...patch } : h)) }));
    setTouched((t) => t.map((v, i) => (i === idx ? true : v)));
  };

  // There is no draft persistence: confirm before leaving with in-progress,
  // non-minted work (any hole touched / element placed, or a name typed).
  const courseHasContent = name.trim().length > 0
    || touched.some(Boolean)
    || course.holes.some((h) => h.elements.length > 0);
  const exitToMarket = () => {
    if (courseHasContent && !window.confirm('Leave the editor? This course is not minted and will be lost.')) return;
    onExit();
  };

  // ── Placement / selection on the grid ──
  const onCellClick = (x: number, y: number) => {
    setTouched((t) => t.map((v, i) => (i === activeHole ? true : v)));
    if (armed === ARM_TEE) { updateHole(activeHole, { tee: { x, y } }); return; }
    if (armed === ARM_CUP) { updateHole(activeHole, { cup: { x, y } }); return; }
    if (armed !== null) {
      // Place a normal element. Pairs (tunnel/ramp) auto-assign a pair id.
      const isPair = armed === EK.TunnelEntrance || armed === EK.TunnelExit
        || armed === EK.RampUp || armed === EK.RampDown;
      const pairId = isPair ? nextPairIdRef.current : 0;
      const el: Element = {
        kind: armed as Element['kind'], x, y, rot: 0,
        params: defaultParams(armed as Element['kind'], pairId),
      };
      // Advance the pair id after placing an "exit"/"down" so the next pair is new.
      if (armed === EK.TunnelExit || armed === EK.RampDown) nextPairIdRef.current += 1;
      updateHole(activeHole, { elements: placeElement(hole, el) });
      return;
    }
    // Select mode: select an element under the cell (if any).
    const idx = elementAt(hole, x, y);
    setSelected(idx >= 0 ? idx : null);
  };

  const rotateSelected = () => {
    if (selected === null) return;
    const el = hole.elements[selected];
    updateHole(activeHole, { elements: hole.elements.map((e, i) => (i === selected ? rotateElement(el) : e)) });
  };

  const deleteSelected = () => {
    if (selected === null) return;
    updateHole(activeHole, { elements: deleteElementAt(hole, selected) });
    setSelected(null);
  };

  // Keyboard: R rotates, Delete/Backspace deletes the selected element.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'r' || e.key === 'R') rotateSelected();
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, activeHole, course]);

  const par = parTotal(course);
  const gate = useMemo(() => mintGate(course, name), [course, name]);

  const armPalette = (kind: number) => {
    setArmed((cur) => (cur === kind ? null : kind));
    setSelected(null);
  };

  const launchPlaytest = () => {
    if (!inGrid(hole.tee, hole) || !inGrid(hole.cup, hole)) return;
    setPlaytest(holeFromCourseData(hole));
  };

  // Playtest renders the active hole through the SAME engine/renderKit as play.
  if (playtest) {
    return (
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b style={{ fontSize: 14 }}>Playtest · Hole {activeHole + 1} (records nothing)</b>
          <Btn variant="ghost" sm onClick={() => setPlaytest(null)}><Icon name="x" size={12} /> Exit playtest</Btn>
        </div>
        <MiniGolf
          course={[playtest]}
          character={character}
          fullAccess
          onRoundComplete={() => {}}
          onExit={() => setPlaytest(null)}
          onGoParticipate={() => setPlaytest(null)}
        />
      </div>
    );
  }

  const teeCupReady = inGrid(hole.tee, hole) && inGrid(hole.cup, hole);

  return (
    <div className="col" style={{ gap: 14 }}>
      {/* ── Back to marketplace (standalone bar, above the header) ── */}
      <div className="dashboard-container" style={{ paddingBottom: 0 }}>
        <Btn variant="ghost" sm onClick={exitToMarket} style={{ alignSelf: 'flex-start' }}>
          <Icon name="undo" size={13} /> Marketplace
        </Btn>
      </div>

      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Arcade · Course NFT</Eyebrow>
        <span className="row" style={{ gap: 10 }}>
          <Icon name="gamepad" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Course Editor</h4>
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 580, margin: 0 }}>
          Build a 9-hole course, then mint it as an NFT.{' '}
          <MoreInfo title="Create → mint → list → earn">
            <p>Place a tee and a cup on each of the 9 holes, set each par, add obstacles, and
            mint. Minting burns 0.5 ICP and auto-lists your course in the marketplace.
            You earn a lottery ticket each time a player reaches hole 2 on your course.</p>
          </MoreInfo>{' '}
          <MoreInfo title="Course rules">
            <p>Courses you mint are public NFTs. Low-rated courses may be hidden or burned by
            moderators without warning.</p>
          </MoreInfo>
        </p>
      </div>

      {/* ── Row 1 — name + actions ── */}
      <div className="card row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="burn-input"
            placeholder="Course name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ minWidth: 220 }}
          />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{name.length}/60</span>
        </span>
        <span className="row" style={{ gap: 8 }}>
          <Btn variant="secondary" sm onClick={launchPlaytest}>Playtest</Btn>
          <span title={gate.ok ? 'Mint as NFT' : gate.reasons.join('\n')}>
            <Btn variant="primary" sm disabled={!gate.ok} onClick={() => setShowMint(true)}>
              <Icon name="flame" size={11} stroke="var(--char-950)" /> Mint as NFT
            </Btn>
          </span>
        </span>
      </div>

      {!gate.ok && (
        <div className="card" style={{ borderColor: 'var(--border-hi)', fontSize: 12, color: 'var(--fg-3)' }}>
          <b style={{ color: 'var(--fg-2)' }}>Before you can mint:</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {gate.reasons.slice(0, 6).map((r, i) => <li key={i}>{r}</li>)}
            {gate.reasons.length > 6 && <li>…and {gate.reasons.length - 6} more</li>}
          </ul>
        </div>
      )}

      {/* ── Row 2 — horizontal hole selector ── */}
      <div className="card col" style={{ gap: 8 }}>
        <span className="row" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>Holes</span>
          <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Par {par} · {difficultyBucket(par)}</Chip>
        </span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {course.holes.map((h, i) => {
            const st = holeStatus(h, touched[i]);
            const tone = st.kind === 'complete' ? 'ok' : st.kind === 'incomplete' ? 'danger' : 'muted';
            const glyph = st.kind === 'complete' ? '✓' : st.kind === 'incomplete' ? '⚠' : '○';
            return (
              <button key={i} onClick={() => { setActiveHole(i); setSelected(null); }}
                className="col" style={{
                  gap: 4, textAlign: 'left', padding: 8, borderRadius: 8, cursor: 'pointer',
                  flex: '0 0 168px',
                  background: i === activeHole ? 'var(--burn-950)' : 'transparent',
                  border: `1px solid ${i === activeHole ? 'var(--burn)' : 'var(--border)'}`,
                }}>
                <span className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                  <b style={{ fontSize: 12.5 }}>Hole {i + 1}</b>
                  <Chip tone={tone} style={{ height: 17, fontSize: 9.5 }}>{glyph}</Chip>
                </span>
                <input
                  className="burn-input"
                  placeholder={`Hole ${i + 1}`}
                  maxLength={30}
                  value={h.name ?? ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateHole(i, { name: e.target.value || undefined })}
                  style={{ fontSize: 11, height: 26 }}
                />
                <span className="row" style={{ gap: 3 }}>
                  {[2, 3, 4, 5].map((p) => (
                    <button key={p} onClick={(e) => { e.stopPropagation(); updateHole(i, { par: p }); }}
                      style={{
                        flex: 1, height: 22, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                        background: h.par === p ? 'var(--burn)' : 'transparent',
                        color: h.par === p ? 'var(--char-950)' : 'var(--fg-3)',
                        border: `1px solid ${h.par === p ? 'var(--burn)' : 'var(--border)'}`,
                      }}>{p}</button>
                  ))}
                </span>
                {st.kind === 'incomplete' && <span style={{ fontSize: 10, color: 'var(--ember)' }}>{st.reason}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Row 3 — build panes: palette · editable map · live preview ── */}
      <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Pane 1 — Items to add (palette) */}
        <div className="col" style={{ gap: 10, flex: '0 0 180px', minWidth: 160 }}>
          <span style={{ fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>Items to add</span>
          {PALETTE.map((grp) => (
            <div key={grp.group} className="col" style={{ gap: 5 }}>
              <span style={{ fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>{grp.group}</span>
              <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                {grp.items.map((it) => (
                  <button key={it.label} onClick={() => armPalette(it.kind)} title={it.label}
                    style={{
                      fontSize: 11, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                      background: armed === it.kind ? 'var(--burn)' : 'transparent',
                      color: armed === it.kind ? 'var(--char-950)' : 'var(--fg-2)',
                      border: `1px solid ${armed === it.kind ? 'var(--burn)' : 'var(--border)'}`,
                    }}>{it.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Pane 2 — editable clickable map */}
        <div className="col" style={{ gap: 8, flex: '1 1 420px', minWidth: 320 }}>
          {!teeCupReady && (
            <div className="row" style={{ gap: 8, color: 'var(--ember)', fontSize: 12 }}>
              <Icon name="info" size={13} stroke="var(--ember)" />
              {!inGrid(hole.tee, hole) ? 'Arm "Tee" and click a cell.' : 'Arm "Cup" and click a cell.'}
            </div>
          )}
          <HoleGrid
            hole={hole}
            theme={course.theme}
            selected={selected}
            onCellClick={onCellClick}
          />
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
              Arm a palette item and click to place · click a placed element to select · R rotates · Del removes
            </span>
            {selected !== null && (
              <span className="row" style={{ gap: 6 }}>
                <Btn variant="ghost" sm onClick={rotateSelected}><Icon name="refresh" size={11} /> Rotate</Btn>
                <Btn variant="danger" sm onClick={deleteSelected}><Icon name="x" size={11} /> Delete</Btn>
              </span>
            )}
          </div>
        </div>

        {/* Pane 3 — live in-game static render of the active hole (no ball) */}
        <div className="col" style={{ gap: 6, flex: '0 0 280px', minWidth: 220 }}>
          <span style={{ fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>In-game preview</span>
          <HolePreview hole={hole} theme={course.theme} />
          <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>How this hole looks in play (no ball).</span>
        </div>
      </div>

      {showMint && (
        <MintDialog
          actor={actor}
          identity={identity}
          host={host}
          rootKey={rootKey}
          ledgerCanisterId={ledgerCanisterId}
          course={course}
          name={name.trim()}
          onClose={() => setShowMint(false)}
          onMinted={onMinted}
        />
      )}
    </div>
  );
}

function inGrid(c: { x: number; y: number }, h: Hole): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < h.gridW && c.y < h.gridH;
}

// ── Clickable grid canvas (theme-tinted) ──
function HoleGrid({ hole, theme, selected, onCellClick }: {
  hole: Hole;
  theme: Theme;
  selected: number | null;
  onCellClick: (x: number, y: number) => void;
}) {
  const cellPx = Math.max(14, Math.min(26, Math.floor(560 / hole.gridW)));
  const bg = theme.kind === 'custom' ? theme.primary : THEME_BG[theme.kind] ?? '#2c3e2c';
  const elByCell = new Map<string, { el: Element; idx: number }>();
  hole.elements.forEach((el, idx) => elByCell.set(`${el.x},${el.y}`, { el, idx }));

  const cells = [];
  for (let y = 0; y < hole.gridH; y++) {
    for (let x = 0; x < hole.gridW; x++) {
      const isTee = hole.tee.x === x && hole.tee.y === y;
      const isCup = hole.cup.x === x && hole.cup.y === y;
      const placed = elByCell.get(`${x},${y}`);
      const isSel = placed && placed.idx === selected;
      cells.push(
        <button key={`${x},${y}`} onClick={() => onCellClick(x, y)} title={`${x},${y}`}
          style={{
            width: cellPx, height: cellPx, padding: 0, cursor: 'pointer', lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: Math.floor(cellPx * 0.6),
            background: isSel ? 'var(--burn)' : 'transparent',
            color: isTee ? '#fff' : isCup ? '#000' : 'var(--char-950)',
            border: `1px solid rgba(255,255,255,0.08)`,
          }}>
          {isTee ? 'T' : isCup ? 'C' : placed ? (ELEMENT_GLYPH[placed.el.kind] ?? '?') : ''}
        </button>,
      );
    }
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${hole.gridW}, ${cellPx}px)`,
      background: bg, borderRadius: 10, padding: 6, width: 'fit-content', maxWidth: '100%', overflow: 'auto',
    }}>
      {cells}
    </div>
  );
}

const THEME_BG: Record<string, string> = {
  desert: '#9a7b4f', ocean: '#2f6d6a', space: '#2a2a44', forest: '#2f5a2f',
};

// ── Live preview: a frozen, ball-less in-game render of the active hole ──
// Renders through the SAME art layer the real game uses (activeRenderKit) via a
// thin Canvas2D → Renderer adapter. We call drawTerrain + drawElement only
// (never drawBall) at a fixed t=0 so it's a static snapshot. Re-renders whenever
// the active hole, its elements, or the theme change.

/** Adapt a real 2D context to the kit's backend-agnostic Renderer interface. */
function canvas2dRenderer(ctx: CanvasRenderingContext2D): Renderer {
  return {
    save: () => ctx.save(),
    restore: () => ctx.restore(),
    setFill: (c) => { ctx.fillStyle = c; },
    setStroke: (c, w) => { ctx.strokeStyle = c; ctx.lineWidth = w; },
    fillRect: (x, y, w, h) => ctx.fillRect(x, y, w, h),
    strokeRect: (x, y, w, h) => ctx.strokeRect(x, y, w, h),
    fillCircle: (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); },
    strokeCircle: (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); },
    strokeLine: (pts) => {
      if (pts.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    },
    fillPoly: (pts) => {
      if (pts.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    },
  };
}

/** Build the per-element ElementViews the kit's drawElement consumes, derived
 *  from the same engine geometry as play (holeFromCourseData). Terrain elements
 *  are drawn by drawTerrain (rasterized into cells), so they yield no view. */
function elementViews(hole: Hole): ElementView[] {
  const views: ElementView[] = [];
  for (const e of hole.elements) {
    // Re-derive canonical geometry by compiling a single-element hole. This
    // reuses the engine's exact element→geometry mapping (no duplication).
    const def = holeFromCourseData({ ...hole, elements: [e] });
    const center: Vec = { x: (e.x + 0.5) * CELL, y: (e.y + 0.5) * CELL };
    const rot = e.rot;
    if (def.walls && def.walls.length) views.push({ kind: e.kind, center, rot, walls: def.walls });
    else if (def.statics && def.statics.length) views.push({ kind: e.kind, center, rot, static: def.statics[0] });
    else if (def.movers && def.movers.length) views.push({ kind: e.kind, center, rot, mover: def.movers[0] });
    else views.push({ kind: e.kind, center, rot }); // tunnels/ramps/tiles → special marker
  }
  return views;
}

function HolePreview({ hole, theme }: { hole: Hole; theme: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const def = holeFromCourseData(hole);
    const worldW = def.w * CELL, worldH = def.h * CELL;
    // Fit the world into the canvas, preserving aspect (letterbox).
    const scale = Math.min(canvas.width / worldW, canvas.height / worldH);
    const offX = (canvas.width - worldW * scale) / 2;
    const offY = (canvas.height - worldH * scale) / 2;

    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = '#101813';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.setTransform(scale, 0, 0, scale, offX, offY);

    const r = canvas2dRenderer(ctx2d);
    const kit = activeRenderKit(theme);
    kit.drawTerrain(r, def, theme);
    for (const v of elementViews(hole)) kit.drawElement(r, v, theme, 0); // t=0 → frozen, no ball
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  }, [hole, theme]);

  return (
    <canvas
      ref={canvasRef}
      width={520}
      height={340}
      style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 10, border: '1px solid var(--border-hi)', background: '#101813' }}
    />
  );
}

// ── Mint dialog (PB-304 hand-off): summary → deposit 0.5 ICP → mint_course_nft ──
function MintDialog({ actor, identity, host, rootKey, ledgerCanisterId, course, name, onClose, onMinted }: {
  actor: any;
  identity: Identity | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  course: CourseDataV1;
  name: string;
  onClose: () => void;
  onMinted: (id: bigint) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const par = parTotal(course);

  const mapMintError = (e: any): string => {
    switch (e.__kind__) {
      case 'NotAuthenticated': return 'Sign in to mint a course.';
      case 'InvalidCourse': return `This course isn't valid: ${e.InvalidCourse}.`;
      case 'InsufficientDeposit': return 'Deposit 0.5 ICP first, then mint.';
      case 'FeeSettlementFailed': return 'Couldn\'t process the fee — try again.';
      case 'MintCallFailed': return 'Mint failed after charging — try again (you won\'t be re-charged).';
      case 'AlreadyMinting': return 'A mint is already in progress.';
      default: return 'Mint failed.';
    }
  };

  const confirm = async () => {
    if (busy || !identity) return;
    setBusy(true);
    setErr(null);
    try {
      setStep('Charging 0.5 ICP…');
      const acct = await actor.get_mint_deposit_address();
      const ledger = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
      const transfer = await ledger.icrc1_transfer({
        to: { owner: acct.owner, subaccount: acct.subaccount ? acct.subaccount : undefined },
        amount: MINT_FEE_E8S + ICP_FEE_E8S,
      });
      if (transfer.__kind__ === 'Err') {
        throw new Error('Deposit failed: ' + JSON.stringify(transfer.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
      }
      setStep('Minting your course NFT…');
      const blob = encodeCourseData(course);
      const res = await actor.mint_course_nft(blob, name);
      if (res.__kind__ === 'Err') throw new Error(mapMintError(res.Err));
      onMinted(res.Ok);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
      setStep('');
    }
  };

  return (
    <ModalShell title="Mint this course as an NFT" onClose={() => !busy && onClose()}>
      <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
        <b>{name}</b> · Par {par} ({difficultyBucket(par)})
      </p>
      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
        <table className="mono" style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
          <tbody>
            {course.holes.map((h, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '3px 6px', color: 'var(--fg-3)' }}>{i + 1}</td>
                <td style={{ padding: '3px 6px' }}>{h.name || `Hole ${i + 1}`}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>Par {h.par}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>
        Minting burns <b>0.5 ICP</b> (50% treasury / 25% backend cycles / 25% frontend cycles).
        Non-refundable. Your course is auto-listed and earns lottery tickets when players reach hole 2.
      </p>
      {step && !err && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{step}</span>}
      {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" sm disabled={busy} onClick={confirm}>
          {busy ? 'Working…' : err ? 'Retry' : `Confirm & Mint (${fmtICP(MINT_FEE_E8S)} ICP)`}
        </Btn>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)', backdropFilter: 'blur(8px)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div className="card col" style={{
        maxWidth: 460, width: '100%', gap: 14, background: 'var(--surface)',
        border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '90vh', overflowY: 'auto',
      }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>{title}</b>
          <Btn variant="ghost" sm onClick={onClose}><Icon name="x" size={14} /></Btn>
        </div>
        {children}
      </div>
    </div>
  );
}
