import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon } from '../ui';
import type { HoleDef } from './engine';
import { fitView, isoP, isoUn, renderHoleScene, type IsoView } from './holeRender';

// ==========================================
// Course overview — the "course map" a player sees before teeing off.
// A 3×3 grid of the 9 holes (mini renders of the real voxel scene) with two
// per-hole actions: Preview (spectate the live scene — no ball, no golfer —
// with pan & zoom) and Play (unscored single-hole practice). The primary CTA
// starts the normal scored round. Pure presentation: all game/session flow
// stays in CoursePlay.
// ==========================================

const SPECTATE_W = 860, SPECTATE_H = 510; // matches MiniGolf's canvas
const THUMB_W = 200, THUMB_H = 130;
const ZOOM_MIN = 0.5, ZOOM_MAX = 4; // × the fitted scale

interface CourseOverviewProps {
  course: HoleDef[];
  courseName: string;
  /** Start the normal scored round (the ticket-earning path). When omitted the
   *  overview is spectate-only (the "View NFT" grid) — no "Play the course" CTA. */
  onPlayRound?: () => void;
  /** Unscored single-hole practice. */
  onPracticeHole: (idx: number) => void;
  /** Back to the marketplace. */
  onExit: () => void;
  /** Override the sub-header line (default = the marketplace ticket copy). */
  hint?: string;
}

export default function CourseOverview({ course, courseName, onPlayRound, onPracticeHole, onExit, hint }: CourseOverviewProps) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const parTotal = course.reduce((s, h) => s + h.par, 0);

  return previewIdx === null ? (
    <div className="col" style={{ gap: 12 }}>
      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 4 }}>
          <b style={{ fontSize: 16 }}>{courseName}</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            {course.length} holes · Par {parTotal}
          </span>
        </div>
        <span className="row" style={{ gap: 8 }}>
          <Btn variant="ghost" sm onClick={onExit}><Icon name="chevLeft" size={12} /> Back</Btn>
          {onPlayRound && (
            <Btn variant="primary" onClick={onPlayRound}>
              <Icon name="flame" size={13} stroke="var(--char-950)" /> Play the course
            </Btn>
          )}
        </span>
      </div>
      <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
        {hint ?? 'Play the full course to earn a lottery ticket. Preview any hole to scout it — or practice it solo (unscored).'}
      </span>

      {/* ── 3×3 hole grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {course.map((def, i) => (
          <HoleTile
            key={i}
            def={def}
            idx={i}
            onPreview={() => setPreviewIdx(i)}
            onPlay={() => onPracticeHole(i)}
          />
        ))}
      </div>
    </div>
  ) : (
    <SpectateView
      course={course}
      idx={previewIdx}
      onChangeIdx={setPreviewIdx}
      onPractice={onPracticeHole}
      onBack={() => setPreviewIdx(null)}
    />
  );
}

// ── One grid tile: static thumbnail + actions ──
function HoleTile({ def, idx, onPreview, onPlay }: { def: HoleDef; idx: number; onPreview: () => void; onPlay: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    renderHoleScene(ctx, def, fitView(def, THUMB_W, THUMB_H, 8), { tSec: 0, ball: null, backdrop: true });
  }, [def]);

  return (
    <div className="col" style={{ gap: 8, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', padding: 10 }}>
      <canvas
        ref={canvasRef}
        width={THUMB_W}
        height={THUMB_H}
        style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 6, background: '#101813' }}
      />
      <span className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <b className="mono" style={{ color: 'var(--fg-3)' }}>{idx + 1}</b> {def.name || `Hole ${idx + 1}`}
        </span>
        <Chip tone="muted" style={{ height: 18, fontSize: 10 }}>Par {def.par}</Chip>
      </span>
      <span className="row" style={{ gap: 6 }}>
        <Btn variant="ghost" sm onClick={onPreview} title="Fly over this hole — pan & zoom, no ball">
          <Icon name="eye" size={11} /> Preview
        </Btn>
        <Btn variant="secondary" sm onClick={onPlay} title="Practice this hole (not scored)">
          <Icon name="flame" size={11} /> Play
        </Btn>
      </span>
    </div>
  );
}

// ── Spectate: the live scene (windmills/water animate) with pan & zoom ──
function SpectateView({ course, idx, onChangeIdx, onPractice, onBack }: {
  course: HoleDef[];
  idx: number;
  onChangeIdx: (i: number) => void;
  onPractice: (i: number) => void;
  onBack: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<IsoView | null>(null);
  const fitScaleRef = useRef(1);
  const def = course[idx];

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const fitted = fitView(def, SPECTATE_W, SPECTATE_H, 24);
    viewRef.current = { ...fitted };
    fitScaleRef.current = fitted.scale;

    // Pointer coords → canvas-internal coords (the canvas is CSS-scaled).
    const toCanvas = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * canvas.width,
        y: ((e.clientY - r.top) / r.height) * canvas.height,
      };
    };

    /** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
    const zoomAt = (sx: number, sy: number, factor: number) => {
      const view = viewRef.current!;
      const next = Math.max(fitScaleRef.current * ZOOM_MIN, Math.min(fitScaleRef.current * ZOOM_MAX, view.scale * factor));
      if (next === view.scale) return;
      const w = isoUn(view, sx, sy);
      view.scale = next;
      const p = isoP(view, w.x, w.y, 0);
      view.ox += sx - p.x;
      view.oy += sy - p.y;
    };

    // One pointer pans; two pinch-zoom toward their midpoint.
    const pointers = new Map<number, { x: number; y: number }>();
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, toCanvas(e));
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const view = viewRef.current!;
      const now = toCanvas(e);
      if (pointers.size === 1) {
        const prev = pointers.get(e.pointerId)!;
        view.ox += now.x - prev.x;
        view.oy += now.y - prev.y;
      } else if (pointers.size === 2) {
        const [idA, idB] = [...pointers.keys()];
        const a0 = pointers.get(idA)!, b0 = pointers.get(idB)!;
        const a1 = e.pointerId === idA ? now : a0;
        const b1 = e.pointerId === idB ? now : b0;
        const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
        const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
        if (d0 > 0 && d1 > 0) zoomAt((a1.x + b1.x) / 2, (a1.y + b1.y) / 2, d1 / d0);
      }
      pointers.set(e.pointerId, now);
    };
    const up = (e: PointerEvent) => pointers.delete(e.pointerId);
    // React attaches wheel listeners passively — a native non-passive listener
    // is required for preventDefault (page must not scroll while zooming).
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toCanvas(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });

    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      renderHoleScene(ctx, def, viewRef.current!, { tSec: now / 1000, ball: null, golfer: null, backdrop: true });
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [def]);

  const resetView = () => {
    const fitted = fitView(def, SPECTATE_W, SPECTATE_H, 24);
    viewRef.current = { ...fitted };
    fitScaleRef.current = fitted.scale;
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <b style={{ fontSize: 14 }}>Preview · Hole {idx + 1}/{course.length} · {def.name || `Hole ${idx + 1}`}</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Par {def.par}</span>
        </span>
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Btn variant="ghost" sm onClick={() => onChangeIdx((idx + course.length - 1) % course.length)}>
            <Icon name="chevLeft" size={12} /> Prev
          </Btn>
          <Btn variant="ghost" sm onClick={() => onChangeIdx((idx + 1) % course.length)}>
            Next <Icon name="chevRight" size={12} />
          </Btn>
          <Btn variant="ghost" sm onClick={resetView} title="Re-centre and re-fit the hole">
            <Icon name="refresh" size={12} /> Reset view
          </Btn>
          <Btn variant="secondary" sm onClick={() => onPractice(idx)}>
            <Icon name="flame" size={12} /> Play this hole
          </Btn>
          <Btn variant="ghost" sm onClick={onBack}><Icon name="x" size={12} /> Back to course map</Btn>
        </span>
      </div>

      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-hi)' }}>
        <canvas
          ref={canvasRef}
          width={SPECTATE_W}
          height={SPECTATE_H}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: 'grab', background: '#101813' }}
        />
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
        Drag to pan · scroll or pinch to zoom — spectating only, no ball in play.
      </span>
    </div>
  );
}
