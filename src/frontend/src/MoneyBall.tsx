import { useEffect, useRef } from 'react';

// ==========================================
// MoneyBall — the Squid-Game piggy-bank orb, Cycle Burn edition.
// A transparent sphere hangs from a cable and slowly fills with ICP
// tokens as the pot grows toward the draw threshold. fill = pot/minPot
// (capped at 1). Pure canvas, no assets (CSP), gentle 30fps-ish work.
// ==========================================

/** Hex-pack coin centers from the sphere's floor upward; unit sphere r=1,
 *  coin radius rc. Returns at most maxCoins slots, bottom-up. Exported for
 *  tests: every slot must sit inside the glass (|p| ≤ 1 − rc). */
export function coinSlots(rc: number, maxCoins: number): { x: number; y: number }[] {
  const slots: { x: number; y: number }[] = [];
  const rowH = rc * 1.74; // hex vertical pitch
  for (let row = 0; slots.length < maxCoins; row++) {
    const y = -1 + rc + row * rowH; // sphere floor upward (y up)
    if (y > 1 - rc) break;
    const halfWidth = Math.sqrt(Math.max(0, (1 - rc) * (1 - rc) - y * y));
    const offset = row % 2 === 1 ? rc : 0;
    for (let x = -halfWidth + offset; x <= halfWidth + 1e-9; x += rc * 2) {
      if (Math.hypot(x, y) <= 1 - rc + 1e-9) slots.push({ x, y });
      if (slots.length >= maxCoins) break;
    }
  }
  return slots;
}

const MAX_COINS = 90;
const COIN_R = 0.105; // relative to sphere radius

interface MoneyBallProps {
  /** 0..1 — how full the ball is (pot / draw threshold, capped). */
  fill: number;
  /** Pixel size of the whole stage (ball is ~70% of width). */
  width?: number;
  height?: number;
}

export default function MoneyBall({ fill, width = 210, height = 260 }: MoneyBallProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fillRef = useRef(fill);
  fillRef.current = fill;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const slots = coinSlots(COIN_R, MAX_COINS);
    // Deterministic per-coin jitter so the pile looks organic, not gridded.
    const jitter = slots.map((_, i) => ({
      dx: Math.sin(i * 12.9898) * 0.018,
      dy: Math.cos(i * 78.233) * 0.012,
      spin: (Math.sin(i * 3.7) + 1) / 2,
    }));

    let raf = 0;
    let dropProgress = 1; // 0..1 — the newest coin falling in
    let shown = Math.round(Math.min(1, Math.max(0, fillRef.current)) * MAX_COINS);

    const draw = (tMs: number) => {
      raf = requestAnimationFrame(draw);
      const t = tMs / 1000;
      const target = Math.round(Math.min(1, Math.max(0, fillRef.current)) * MAX_COINS);
      // One coin at a time drops in until we reach the live fill level.
      if (shown < target && dropProgress >= 1) dropProgress = 0;
      if (dropProgress < 1) {
        dropProgress = Math.min(1, dropProgress + 0.035);
        if (dropProgress >= 1) shown = Math.min(shown + 1, target);
      }
      if (shown > target) shown = target; // pot paid out — ball empties

      const W = width, H = height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // Gentle pendulum sway around the ceiling anchor.
      const sway = Math.sin(t * 0.7) * 0.028;
      const ax = W / 2, ay = 6;
      ctx.translate(ax, ay);
      ctx.rotate(sway);

      const R = W * 0.36;          // sphere radius (px)
      const cy = 64 + R;           // sphere center below the anchor

      // Cable + collar.
      ctx.strokeStyle = 'rgba(128,126,120,0.9)';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, cy - R - 10); ctx.stroke();
      ctx.fillStyle = 'rgba(128,126,120,0.9)';
      ctx.beginPath(); ctx.arc(0, 0, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-7, cy - R - 12, 14, 10);

      // Glass sphere back: faint fill + rim.
      const glass = ctx.createRadialGradient(-R * 0.35, cy - R * 0.4, R * 0.1, 0, cy, R);
      glass.addColorStop(0, 'rgba(255,255,255,0.16)');
      glass.addColorStop(0.7, 'rgba(200,200,205,0.07)');
      glass.addColorStop(1, 'rgba(160,160,165,0.13)');
      ctx.fillStyle = glass;
      ctx.beginPath(); ctx.arc(0, cy, R, 0, Math.PI * 2); ctx.fill();

      // Coins (clip to the glass).
      ctx.save();
      ctx.beginPath(); ctx.arc(0, cy, R * 0.985, 0, Math.PI * 2); ctx.clip();
      const rc = COIN_R * R;
      const coin = (px: number, py: number, spin: number, glintPhase: number) => {
        // ICP-orange token with a rim and a tiny ∞ mark.
        const g = ctx.createRadialGradient(px - rc * 0.35, py - rc * 0.35, rc * 0.15, px, py, rc);
        g.addColorStop(0, '#FF9A5C');
        g.addColorStop(1, '#E85A10');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(px, py, rc, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(120,45,5,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // ∞ mark (two small loops), scale x by spin for a lazy shimmer.
        const sx = 0.55 + 0.45 * Math.abs(Math.sin(glintPhase));
        ctx.strokeStyle = 'rgba(58,20,2,0.8)';
        ctx.lineWidth = Math.max(1, rc * 0.18);
        ctx.beginPath();
        ctx.ellipse(px - rc * 0.28 * sx, py, rc * 0.24 * sx, rc * 0.24, 0, 0, Math.PI * 2);
        ctx.ellipse(px + rc * 0.28 * sx, py, rc * 0.24 * sx, rc * 0.24, 0, 0, Math.PI * 2);
        ctx.stroke();
        void spin;
      };
      for (let i = 0; i < shown; i++) {
        const p = slots[i], j = jitter[i];
        coin((p.x + j.dx) * R, cy - (p.y + j.dy) * R, j.spin, t * 0.6 + i * 1.7);
      }
      // The falling coin.
      if (dropProgress < 1 && shown < slots.length) {
        const p = slots[shown], j = jitter[shown];
        const fromY = cy - R - 16;
        const toY = cy - (p.y + j.dy) * R;
        const eased = dropProgress * dropProgress; // accelerate down
        const bounce = dropProgress > 0.92 ? Math.sin((dropProgress - 0.92) / 0.08 * Math.PI) * rc * 0.35 : 0;
        coin((p.x + j.dx) * R * Math.min(1, dropProgress * 1.6), fromY + (toY - fromY) * eased - bounce, j.spin, t);
      }
      ctx.restore();

      // Glass front: rim + two highlights.
      ctx.strokeStyle = 'rgba(150,148,142,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, cy, R * 0.86, -2.2, -1.35); ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, cy, R * 0.9, 0.5, 1.0); ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-label="Prize ball filling with ICP as the pot grows"
      role="img"
    />
  );
}
