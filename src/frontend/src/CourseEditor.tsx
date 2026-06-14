import { useEffect, useMemo, useRef, useState } from 'react';
import type { Identity } from '@icp-sdk/core/agent';
import { Icon, Eyebrow, Chip, Btn, MoreInfo } from './ui';
import { createActor as createLedgerActor } from './bindings/ledger';
import { fmtICP } from './ui';
import MiniGolf from './arcade/MiniGolf';
import { holeFromCourseData, type HoleDef, type CharacterLook } from './arcade/engine';
import {
  type CourseDataV1, type Hole, type Element, type Theme,
  ElementKind as EK, LIMITS, encodeCourseData,
} from './arcade/courseData';
import {
  emptyCourse, holeStatus, mintGate, parTotal, defaultParams, elementAt,
  placeElement, deleteElementAt, rotateElement,
} from './arcade/courseEditorLogic';
import { difficultyBucket } from './arcade/courseMarket';

// ==========================================
// Course NFT Editor (PB-302) — per-user 9-hole builder producing a CourseDataV1
// blob destined to become an NFT. Four zones: top bar, hole panel, canvas,
// palette. Drafts are LOCAL (localStorage) — the backend draft endpoints
// (save_/get_my_/clear_course_draft) are NOT in this backend build yet, so we
// persist drafts client-side and note it. The Mint flow encodes the course,
// fetches the escrow deposit address, transfers 0.5 ICP, and calls
// mint_course_nft (PB-304).
//
// NOTE: This is a NEW, standalone component. The legacy admin paint editor
// (arcade/CourseEditor.tsx) is intentionally untouched (spec D4).
// ==========================================

const MINT_FEE_E8S = 50_000_000n; // 0.5 ICP
const ICP_FEE_E8S = 10_000n;
const DRAFT_KEY = 'course-nft-draft-v1';

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

const THEME_CHOICES: { kind: Theme['kind']; label: string }[] = [
  { kind: 'desert', label: 'Desert' }, { kind: 'ocean', label: 'Ocean' },
  { kind: 'space', label: 'Space' }, { kind: 'forest', label: 'Forest' },
  { kind: 'custom', label: 'Custom' },
];
const CUSTOM_SWATCHES = ['#e8602c', '#2d7ff0', '#27a05c', '#e3b52e', '#9b59d0', '#22b8c4'];

export default function CourseEditor({
  actor, identity, host, rootKey, ledgerCanisterId, character, onMinted, onExit,
}: CourseEditorProps) {
  const [course, setCourse] = useState<CourseDataV1>(emptyCourse);
  const [name, setName] = useState('');
  const [activeHole, setActiveHole] = useState(0);
  const [armed, setArmed] = useState<number | null>(null); // palette kind, or null = select mode
  const [selected, setSelected] = useState<number | null>(null); // element index in active hole
  const [touched, setTouched] = useState<boolean[]>(() => Array(LIMITS.HOLES).fill(false));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showResume, setShowResume] = useState(false);
  const [playtest, setPlaytest] = useState<HoleDef | null>(null);
  const [showMint, setShowMint] = useState(false);

  const nextPairIdRef = useRef(0);

  // ── Draft resume-or-fresh on mount (localStorage; server drafts not in this
  //    backend build yet — see component note). ──
  useEffect(() => {
    try {
      if (localStorage.getItem(DRAFT_KEY)) setShowResume(true);
    } catch { /* localStorage unavailable — start fresh */ }
  }, []);

  const hole = course.holes[activeHole];

  const updateHole = (idx: number, patch: Partial<Hole>) => {
    setCourse((c) => ({ ...c, holes: c.holes.map((h, i) => (i === idx ? { ...h, ...patch } : h)) }));
    setTouched((t) => t.map((v, i) => (i === idx ? true : v)));
  };

  // ── Autosave every 60s while dirty, plus manual Save (both local). ──
  const dirtyRef = useRef(false);
  // Mark dirty whenever the course or name changes (skip the initial mount).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) dirtyRef.current = true;
    else mountedRef.current = true;
  }, [course, name]);
  useEffect(() => {
    const id = setInterval(() => { if (dirtyRef.current) saveDraft(); }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveDraft = () => {
    try {
      const blob = encodeCourseData(course);
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        name, course: Array.from(blob), updated_at: Date.now(),
      }));
      setSavedAt(Date.now());
      dirtyRef.current = false;
    } catch (e) { console.error('draft save failed', e); }
  };

  const resumeDraft = () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { name: string; course: number[]; updated_at: number };
        // Decode the stored blob back into the editable course.
        import('./arcade/courseData').then(({ decodeCourseData }) => {
          setCourse(decodeCourseData(Uint8Array.from(parsed.course)));
          setName(parsed.name ?? '');
          setTouched(Array(LIMITS.HOLES).fill(true));
        });
      }
    } catch (e) { console.error('draft resume failed', e); }
    setShowResume(false);
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

  return (
    <div className="col" style={{ gap: 14 }}>
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Arcade · Course NFT</Eyebrow>
        <span className="row" style={{ gap: 10 }}>
          <Icon name="gamepad" size={22} stroke="var(--burn)" />
          <h4 style={{ margin: 0 }}>Course Editor</h4>
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 580, margin: 0 }}>
          Build a 9-hole course, then mint it as an NFT.{' '}
          <MoreInfo title="Create → mint → list → earn">
            <p>Place a tee and a cup on each of the 9 holes, set each par, add obstacles, pick a
            theme, and mint. Minting burns 0.5 ICP and auto-lists your course in the marketplace.
            You earn a lottery ticket each time a player reaches hole 2 on your course.</p>
            <p>Drafts are saved in this browser only (server-side drafts aren't enabled in this
            build yet).</p>
          </MoreInfo>
        </p>
      </div>

      {/* ── Top bar ── */}
      <div className="card row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="burn-input"
            placeholder="Course name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ minWidth: 200 }}
          />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{name.length}/60</span>
          <select
            className="burn-input"
            value={course.theme.kind}
            onChange={(e) => {
              const kind = e.target.value as Theme['kind'];
              const theme: Theme = kind === 'custom'
                ? { kind: 'custom', primary: CUSTOM_SWATCHES[0], secondary: CUSTOM_SWATCHES[1] }
                : { kind };
              setCourse((c) => ({ ...c, theme }));
            }}
          >
            {THEME_CHOICES.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
          </select>
          {course.theme.kind === 'custom' && (
            <CustomSwatches theme={course.theme} onChange={(theme) => setCourse((c) => ({ ...c, theme }))} />
          )}
          <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Par {par} · {difficultyBucket(par)}</Chip>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
            {savedAt ? `saved ${Math.round((Date.now() - savedAt) / 1000)}s ago` : 'unsaved'}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Btn variant="ghost" sm onClick={onExit}><Icon name="chevLeft" size={12} /> Marketplace</Btn>
          <Btn variant="secondary" sm onClick={launchPlaytest}>Playtest</Btn>
          <Btn variant="secondary" sm onClick={saveDraft}>Save draft</Btn>
          <span title={gate.ok ? 'Mint as NFT' : gate.reasons.join('\n')}>
            <Btn variant="primary" sm disabled={!gate.ok} onClick={() => setShowMint(true)}>
              <Icon name="flame" size={11} stroke="var(--char-950)" /> Mint as NFT
            </Btn>
          </span>
        </div>
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

      {/* ── Three zones ── */}
      <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Hole panel */}
        <div className="col" style={{ gap: 6, minWidth: 200, flex: '0 0 200px' }}>
          {course.holes.map((h, i) => {
            const st = holeStatus(h, touched[i]);
            const tone = st.kind === 'complete' ? 'ok' : st.kind === 'incomplete' ? 'danger' : 'muted';
            const glyph = st.kind === 'complete' ? '✓' : st.kind === 'incomplete' ? '⚠' : '○';
            return (
              <button key={i} onClick={() => { setActiveHole(i); setSelected(null); }}
                className="col" style={{
                  gap: 4, textAlign: 'left', padding: 8, borderRadius: 8, cursor: 'pointer',
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

        {/* Canvas (clickable grid) */}
        <div className="col" style={{ gap: 8, flex: '1 1 480px', minWidth: 360 }}>
          {(!inGrid(hole.tee, hole) || !inGrid(hole.cup, hole)) && (
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

        {/* Palette */}
        <div className="col" style={{ gap: 10, flex: '0 0 180px', minWidth: 160 }}>
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
      </div>

      {showResume && (
        <ModalShell title="Resume your draft?" onClose={() => setShowResume(false)}>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
            A saved draft was found in this browser. Resume it, or start a fresh course (your
            draft stays until you save over it).
          </p>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Btn variant="ghost" sm onClick={() => setShowResume(false)}>Start fresh</Btn>
            <Btn variant="primary" sm onClick={resumeDraft}>Resume draft</Btn>
          </div>
        </ModalShell>
      )}

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
          onMinted={(id) => {
            try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
            onMinted(id);
          }}
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

function CustomSwatches({ theme, onChange }: { theme: Extract<Theme, { kind: 'custom' }>; onChange: (t: Theme) => void }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      {(['primary', 'secondary'] as const).map((slot) => (
        <span key={slot} className="row" style={{ gap: 2 }}>
          {CUSTOM_SWATCHES.map((c) => (
            <button key={c} onClick={() => onChange({ ...theme, [slot]: c })} title={`${slot} ${c}`}
              style={{
                width: 16, height: 16, borderRadius: 4, background: c, cursor: 'pointer',
                border: theme[slot] === c ? '2px solid var(--fg)' : '1px solid var(--border)',
              }} />
          ))}
        </span>
      ))}
    </span>
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
        <b>{name}</b> · {THEME_CHOICES.find((t) => t.kind === course.theme.kind)?.label} · Par {par} ({difficultyBucket(par)})
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
