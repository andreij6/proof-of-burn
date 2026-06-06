// pob-kit.jsx — Proof of Burn primitives, styled on Incentive Layer tokens.
// Exports to window: PobCtx, Icon, Chip, Btn, Eyebrow, Bar, HeatBar, Gate,
//   Reveal, LiveDot, useCountUp, fmtICP, HEATS.
const { useState, useEffect, useRef, createContext, useContext } = React;

// Tweak-driven context (gating style, ai panel mode, motion intensity)
const PobCtx = createContext({ gating: 'blur', ai: 'collapsed', motion: 'expressive' });

// Curated burn-accent palettes: [burn, 700, 300, 100, 950]
const HEATS = {
  Amber:   ['#FF6A1F', '#E04E0A', '#FFB080', '#FFE4D2', '#2A1409'],
  Ember:   ['#E5484D', '#C13539', '#F2999C', '#FBDDDE', '#2A1213'],
  Citrine: ['#E0A12E', '#B0801F', '#EFD18C', '#F8EDD2', '#2A2110'],
};

// ── Lucide-style stroke icons (1.5px) ─────────────────────────
const P = {
  flame: <path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z" />,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.4l2.5 2.6 4.5-5" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  external: <><path d="M15 3h6v6" /><path d="M10 14L21 3" /><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /></>,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  share: <><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v13" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L21 2M16 7l3 3M14 9l2 2" /></>,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  chevDown: <path d="M6 9l6 6 6-6" />,
  chevRight: <path d="M9 18l6-6-6-6" />,
  zap: <path d="M13 2L3 14h8l-1 8 11-13h-8z" />,
  coins: <><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1110.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82" /></>,
  spark: <path d="M12 3l1.7 5.1a3 3 0 002.2 2.2L21 12l-5.1 1.7a3 3 0 00-2.2 2.2L12 21l-1.7-5.1a3 3 0 00-2.2-2.2L3 12l5.1-1.7a3 3 0 002.2-2.2z" />,
  wallet: <><path d="M19 7V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-2" /><path d="M14 12h7v-2a2 2 0 00-2-2h-5a2 2 0 00-2 2v2a2 2 0 002 2z" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 015 5v0a5 5 0 01-5 5H9" /></>,
  refresh: <><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 4v4h-4" /></>,
};
function Icon({ name, size = 16, stroke = 'currentColor', sw = 1.5, style }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, display: 'block', ...style }}>{P[name]}</svg>;
}

// ── Eyebrow (mono uppercase kicker) ───────────────────────────
function Eyebrow({ children, accent, style }) {
  return <span className="mono" style={{
    fontSize: 10.5, fontWeight: 500, letterSpacing: '0.09em', textTransform: 'uppercase',
    color: accent ? 'var(--burn)' : 'var(--fg-3)', ...style }}>{children}</span>;
}

// ── Chip / status pill ────────────────────────────────────────
const CHIP_TONES = {
  muted:   { bg: 'transparent',        bd: 'var(--border)',  fg: 'var(--fg-2)' },
  burn:    { bg: 'var(--burn-950)',    bd: 'var(--burn)',    fg: 'var(--burn)' },
  solid:   { bg: 'var(--burn)',        bd: 'var(--burn)',    fg: 'var(--char-950)' },
  ok:      { bg: 'var(--sprout-dim)',  bd: 'var(--sprout)',  fg: 'var(--sprout)' },
  danger:  { bg: 'var(--ember-dim)',   bd: 'var(--ember)',   fg: 'var(--ember)' },
  pending: { bg: 'var(--haze-dim)',    bd: 'var(--haze)',    fg: 'var(--haze)' },
  dashed:  { bg: 'transparent',        bd: 'var(--border-hi)', fg: 'var(--fg-3)' },
};
function Chip({ tone = 'muted', children, style }) {
  const c = CHIP_TONES[tone] || CHIP_TONES.muted;
  return <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px',
    borderRadius: 4, border: `1px solid ${c.bd}`, background: c.bg, color: c.fg,
    fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', lineHeight: 1,
    borderStyle: tone === 'dashed' ? 'dashed' : 'solid', ...style }}>{children}</span>;
}

// ── Button ────────────────────────────────────────────────────
function Btn({ variant = 'secondary', sm, children, disabled, style, onClick }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: sm ? 30 : 36, padding: sm ? '0 11px' : '0 15px', borderRadius: 6,
    fontFamily: 'var(--font-body)', fontSize: sm ? 12.5 : 13.5, fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
    transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
    opacity: disabled ? 0.4 : 1, ...style,
  };
  const skins = {
    primary:   { background: 'var(--burn)', color: 'var(--char-950)', border: '1px solid var(--burn)' },
    secondary: { background: 'transparent', color: 'var(--fg)', border: '1px solid var(--border-hi)' },
    ghost:     { background: 'transparent', color: 'var(--fg-2)', border: '1px solid transparent' },
    danger:    { background: 'transparent', color: 'var(--ember)', border: '1px solid var(--ember)' },
  };
  return <button onClick={disabled ? undefined : onClick} style={{ ...base, ...skins[variant] }}>{children}</button>;
}

// ── Skeleton bar (placeholder line) ───────────────────────────
function Bar({ w = '100%', h = 10, faint, style }) {
  return <span style={{ display: 'block', width: w, height: h, borderRadius: 3,
    background: faint ? 'var(--char-800)' : 'var(--border-hi)', opacity: faint ? 0.5 : 0.8, ...style }} />;
}

// ── Animated count-up (numbers) ───────────────────────────────
function useCountUp(target, { enabled = true, duration = 900, decimals = 0 } = {}) {
  const [val, setVal] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) { setVal(target); return; }
    let raf, start;
    const tick = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - p, 3); // out-cubic
      setVal(target * e);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return val.toFixed(decimals);
}

// ── Live pulse dot ────────────────────────────────────────────
function LiveDot({ color = 'var(--burn)', size = 6, on = true, style }) {
  return <span style={{ width: size, height: size, borderRadius: 999, background: color,
    flexShrink: 0, animation: on ? 'il-pulse 2s var(--ease-in-out) infinite' : 'none', ...style }} />;
}

// ── Burn progress meter (with optional count-up) ──────────────
function HeatBar({ pct = 0, committed, req, met, animate }) {
  const { motion } = useContext(PobCtx);
  const on = animate && motion !== 'off';
  const [w, setW] = useState(on ? 0 : pct);
  useEffect(() => {
    if (!on) { setW(pct); return; }
    const id = setTimeout(() => setW(pct), 80);
    return () => clearTimeout(id);
  }, [pct, on]);
  return <div className="col" style={{ gap: 7 }}>
    <div style={{ height: 8, borderRadius: 999, background: 'var(--char-800)', overflow: 'hidden' }}>
      <div style={{ width: w + '%', height: '100%', borderRadius: 999,
        background: met ? 'var(--sprout)' : 'var(--burn)',
        transition: 'width 1s var(--ease-out)' }} />
    </div>
    {(committed || req) && <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
      <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>{committed}</span>
      <span className="mono" style={{ fontSize: 12, color: met ? 'var(--sprout)' : 'var(--burn)', fontWeight: 500, whiteSpace: 'nowrap' }}>{req}</span>
    </div>}
  </div>;
}

// ── Gate (renders real content, then blurs + locks per tweak) ─
function Gate({ children, hint, next, height }) {
  const { gating } = useContext(PobCtx);
  const lockTone = next ? 'burn' : 'muted';
  const overlay = <div style={{ position: 'absolute', inset: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
    <Chip tone={lockTone} style={{ height: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
      <Icon name={next ? 'spark' : 'lock'} size={12} /> {hint}
    </Chip>
  </div>;
  if (gating === 'skeleton') {
    return <div style={{ position: 'relative', minHeight: height }}>
      {overlay}
      <div style={{ filter: 'grayscale(1)', opacity: 0.18, pointerEvents: 'none', userSelect: 'none' }}>{children}</div>
    </div>;
  }
  if (gating === 'faded') {
    return <div style={{ position: 'relative', minHeight: height }}>
      {overlay}
      <div style={{ opacity: 0.28, pointerEvents: 'none', userSelect: 'none',
        maskImage: 'linear-gradient(to bottom, #000, rgba(0,0,0,0.4))' }}>{children}</div>
    </div>;
  }
  // default: blur
  return <div style={{ position: 'relative', minHeight: height }}>
    {overlay}
    <div style={{ filter: 'blur(5px) saturate(0.6)', opacity: 0.5, pointerEvents: 'none',
      userSelect: 'none' }}>{children}</div>
  </div>;
}

// ── Reveal (staggered de-blur / fade-up on mount) ─────────────
function Reveal({ delay = 0, children, style }) {
  const { motion } = useContext(PobCtx);
  const [shown, setShown] = useState(motion === 'off');
  useEffect(() => {
    if (motion === 'off') { setShown(true); return; }
    const id = setTimeout(() => setShown(true), 70 + delay);
    return () => clearTimeout(id);
  }, []);
  const dur = motion === 'subtle' ? 260 : 440;
  return <div style={{
    opacity: shown ? 1 : 0,
    transform: shown ? 'none' : 'translateY(10px)',
    filter: shown ? 'none' : (motion === 'expressive' ? 'blur(4px)' : 'none'),
    transition: `opacity ${dur}ms var(--ease-out), transform ${dur}ms var(--ease-out), filter ${dur}ms var(--ease-out)`,
    ...style }}>{children}</div>;
}

function fmtICP(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

Object.assign(window, { PobCtx, HEATS, Icon, Eyebrow, Chip, Btn, Bar, HeatBar, Gate, Reveal, LiveDot, useCountUp, fmtICP });
