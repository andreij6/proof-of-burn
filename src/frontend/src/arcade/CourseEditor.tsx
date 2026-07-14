import { useEffect, useState } from 'react';
import { Btn, Chip, Icon } from '../ui';
import { useErrorImpression } from '../analytics';
import { backendErr, toFriendly } from '../errors';
import {
  COURSE, GRID_W, GRID_H, CELL, CellType, WALKABLE, HOLES_PER_ROUND,
  holeToBackend, type BackendHole,
} from './engine';

// ==========================================
// Admin course editor — paint the voxel layout of any Mini Golf hole
// cell by cell, place the tee/cup/windmill, and save it on-chain
// (admin_set_arcade_hole). Saved holes override the built-in layout for
// every player; Reset reverts to the built-in.
// ==========================================

type Tool = 'grass' | 'wall' | 'sand' | 'water' | 'slopeN' | 'slopeS' | 'slopeE' | 'slopeW' | 'post' | 'void' | 'tee' | 'cup' | 'windmill';

const TOOLS: { key: Tool; label: string; color: string; cell?: CellType }[] = [
  { key: 'grass', label: 'Grass', color: '#3ec46a', cell: CellType.Grass },
  { key: 'wall', label: 'Wall', color: '#e0b667', cell: CellType.Wall },
  { key: 'sand', label: 'Sand', color: '#efd98a', cell: CellType.Sand },
  { key: 'water', label: 'Water', color: '#3f9bee', cell: CellType.Water },
  { key: 'slopeN', label: 'Slope ↑', color: '#2da455', cell: CellType.SlopeN },
  { key: 'slopeS', label: 'Slope ↓', color: '#2da455', cell: CellType.SlopeS },
  { key: 'slopeE', label: 'Slope →', color: '#2da455', cell: CellType.SlopeE },
  { key: 'slopeW', label: 'Slope ←', color: '#2da455', cell: CellType.SlopeW },
  { key: 'post', label: 'Post', color: '#d9a85b', cell: CellType.Post },
  { key: 'void', label: 'Void', color: '#1a1714', cell: CellType.Void },
  { key: 'tee', label: 'Tee', color: '#ffffff' },
  { key: 'cup', label: 'Cup', color: '#0c0a08' },
  { key: 'windmill', label: 'Windmill', color: '#d77b45' },
];

const CELL_COLORS: Record<number, string> = {
  [CellType.Void]: '#1a1714',
  [CellType.Grass]: '#3ec46a',
  [CellType.Wall]: '#e0b667',
  [CellType.Sand]: '#efd98a',
  [CellType.Water]: '#3f9bee',
  [CellType.SlopeN]: '#2da455',
  [CellType.SlopeS]: '#2da455',
  [CellType.SlopeE]: '#2da455',
  [CellType.SlopeW]: '#2da455',
  [CellType.Post]: '#d9a85b',
};

const SLOPE_GLYPH: Record<number, string> = {
  [CellType.SlopeN]: '↑', [CellType.SlopeS]: '↓', [CellType.SlopeE]: '→', [CellType.SlopeW]: '←',
};

interface Draft {
  name: string;
  par: number;
  cells: number[];
  tee: { x: number; y: number };
  cup: { x: number; y: number };
  bar: { cx: number; cy: number } | null; // one windmill max in the editor
}

function draftFromBackend(b: BackendHole): Draft {
  return {
    name: b.name,
    par: Number(b.par),
    cells: Array.from(b.cells as ArrayLike<number>),
    tee: { x: Number(b.tee_x), y: Number(b.tee_y) },
    cup: { x: Number(b.cup_x), y: Number(b.cup_y) },
    bar: b.bars.length > 0 ? { cx: Number(b.bars[0].cx), cy: Number(b.bars[0].cy) } : null,
  };
}

function draftToBackend(d: Draft): BackendHole {
  return {
    name: d.name.trim() || 'Untitled Hole',
    par: d.par,
    w: GRID_W,
    h: GRID_H,
    cells: Uint8Array.from(d.cells),
    tee_x: d.tee.x, tee_y: d.tee.y,
    cup_x: d.cup.x, cup_y: d.cup.y,
    bars: d.bar ? [{ cx: d.bar.cx, cy: d.bar.cy, len_cells: 3, speed_mrad: 1900 }] : [],
  };
}

export default function CourseEditor({ actor }: { actor: any }) {
  const [holeIdx, setHoleIdx] = useState(0);
  const [overrides, setOverrides] = useState<Map<number, BackendHole>>(new Map());
  const [draft, setDraft] = useState<Draft>(() => draftFromBackend(holeToBackend(COURSE[0])));
  const [tool, setTool] = useState<Tool>('wall');
  const [painting, setPainting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useErrorImpression(error, 'course_editor_page');

  const loadOverrides = async () => {
    if (!actor) return;
    try {
      const entries = await actor.get_arcade_course();
      const map = new Map<number, BackendHole>();
      for (const e of entries) map.set(Number(e.index), e.hole);
      setOverrides(map);
      return map;
    } catch (err) {
      console.error('Failed to load course overrides:', err);
    }
  };

  const loadHole = (idx: number, ovr: Map<number, BackendHole> = overrides) => {
    const base = ovr.get(idx) ?? holeToBackend(COURSE[idx]);
    setDraft(draftFromBackend(base));
    setHoleIdx(idx);
    setStatus(null);
    setError(null);
  };

  useEffect(() => {
    loadOverrides().then(map => { if (map) loadHole(0, map); });
  }, [actor]);

  const isWalkable = (cells: number[], x: number, y: number) =>
    WALKABLE.includes(cells[y * GRID_W + x] as CellType);

  const applyTool = (gx: number, gy: number) => {
    setDraft(d => {
      const next: Draft = { ...d, cells: [...d.cells] };
      const t = TOOLS.find(t => t.key === tool)!;
      if (tool === 'tee' || tool === 'cup') {
        next.cells[gy * GRID_W + gx] = CellType.Grass; // markers sit on grass
        if (tool === 'tee') next.tee = { x: gx, y: gy };
        else next.cup = { x: gx, y: gy };
      } else if (tool === 'windmill') {
        next.bar = d.bar && d.bar.cx === gx && d.bar.cy === gy ? null : { cx: gx, cy: gy };
      } else if (t.cell !== undefined) {
        next.cells[gy * GRID_W + gx] = t.cell;
      }
      return next;
    });
    setStatus(null);
  };

  const clientValidation = (): string | null => {
    if (!isWalkable(draft.cells, draft.tee.x, draft.tee.y)) return 'The tee must sit on grass or a slope.';
    if (!isWalkable(draft.cells, draft.cup.x, draft.cup.y)) return 'The cup must sit on grass or a slope.';
    if (draft.tee.x === draft.cup.x && draft.tee.y === draft.cup.y) return 'Tee and cup can’t share a cell.';
    if (draft.par < 2 || draft.par > 6) return 'Par must be between 2 and 6.';
    return null;
  };

  const save = async () => {
    if (!actor || busy) return;
    const problem = clientValidation();
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await actor.admin_set_arcade_hole(holeIdx, draftToBackend(draft));
      if (res.__kind__ === 'Err') throw backendErr(res.Err, 'course-editor');
      await loadOverrides();
      setStatus(`Hole ${holeIdx + 1} saved on-chain — live for all players.`);
    } catch (err: any) {
      setError(toFriendly(err, 'course-editor'));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!actor || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (overrides.has(holeIdx)) {
        const res = await actor.admin_reset_arcade_hole(holeIdx);
        if (res.__kind__ === 'Err') throw backendErr(res.Err, 'course-editor');
      }
      const map = (await loadOverrides()) ?? new Map();
      loadHole(holeIdx, map);
      setStatus(`Hole ${holeIdx + 1} reverted to the built-in layout.`);
    } catch (err: any) {
      setError(toFriendly(err, 'course-editor'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      {/* Hole selector */}
      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {Array.from({ length: HOLES_PER_ROUND }, (_, i) => (
          <button key={i} onClick={() => loadHole(i)} style={{
            width: 30, height: 28, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
            border: `1px solid ${i === holeIdx ? 'var(--burn)' : 'var(--border)'}`,
            background: i === holeIdx ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
            color: i === holeIdx ? 'var(--burn-ink)' : 'var(--fg-3)',
          }}>
            {i + 1}
          </button>
        ))}
        {overrides.has(holeIdx) && <Chip tone="burn" style={{ height: 20, fontSize: 10 }}>Edited (on-chain)</Chip>}
      </span>

      {/* Name + par */}
      <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <input type="text" className="burn-input" style={{ width: 200 }} maxLength={40} value={draft.name}
          onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>PAR</span>
          <input type="number" className="burn-input" style={{ width: 64, fontFamily: 'var(--font-mono)' }} min={2} max={6}
            value={draft.par} onChange={e => setDraft(d => ({ ...d, par: Number(e.target.value) }))} />
        </span>
      </span>

      {/* Tool palette */}
      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {TOOLS.map(t => (
          <button key={t.key} onClick={() => setTool(t.key)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999,
            cursor: 'pointer', fontSize: 11.5,
            border: `1px solid ${tool === t.key ? 'var(--burn)' : 'var(--border)'}`,
            background: tool === t.key ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
            color: tool === t.key ? 'var(--burn-ink)' : 'var(--fg-2)',
          }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: t.color, border: '1px solid rgba(255,255,255,0.25)' }} />
            {t.label}
          </button>
        ))}
      </span>

      {/* Paint grid (click or drag) */}
      <div
        onMouseLeave={() => setPainting(false)}
        style={{
          display: 'grid', gridTemplateColumns: `repeat(${GRID_W}, 18px)`, gap: 1,
          background: 'var(--border)', border: '1px solid var(--border-hi)', borderRadius: 6,
          padding: 2, width: 'fit-content', userSelect: 'none', overflowX: 'auto', maxWidth: '100%',
        }}
      >
        {Array.from({ length: GRID_H }, (_, gy) =>
          Array.from({ length: GRID_W }, (_, gx) => {
            const c = draft.cells[gy * GRID_W + gx];
            const isTee = draft.tee.x === gx && draft.tee.y === gy;
            const isCup = draft.cup.x === gx && draft.cup.y === gy;
            const isBar = draft.bar && draft.bar.cx === gx && draft.bar.cy === gy;
            return (
              <div
                key={`${gx}-${gy}`}
                onMouseDown={() => { setPainting(true); applyTool(gx, gy); }}
                onMouseEnter={() => { if (painting) applyTool(gx, gy); }}
                onMouseUp={() => setPainting(false)}
                title={`${gx},${gy}`}
                style={{
                  width: 18, height: 18, background: CELL_COLORS[c] ?? '#000', cursor: 'crosshair',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, lineHeight: 1,
                  color: c === CellType.Water ? '#dff0ff' : '#10381f',
                }}
              >
                {isTee ? 'T' : isCup ? '◉' : isBar ? '✕' : SLOPE_GLYPH[c] ?? (c === CellType.Post ? 'o' : '')}
              </div>
            );
          }))}
      </div>

      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
        Click/drag to paint with the selected tool · T = tee, ◉ = cup, ✕ = windmill pivot (3-cell bar, click again to remove) ·
        each cell is one voxel ({CELL}px of green)
      </span>

      {status && <span style={{ fontSize: 12, color: 'var(--sprout-ink)' }}>{status}</span>}
      {error && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{error}</span>}

      <span className="row" style={{ gap: 8 }}>
        <Btn variant="primary" sm disabled={busy} onClick={save}>
          <Icon name="check" size={12} stroke="var(--char-950)" /> {busy ? 'Working…' : `Save hole ${holeIdx + 1} on-chain`}
        </Btn>
        <Btn variant="secondary" sm disabled={busy} onClick={reset}>
          <Icon name="undo" size={12} /> Reset to built-in
        </Btn>
      </span>
    </div>
  );
}
