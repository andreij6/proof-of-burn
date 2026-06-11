import React from 'react';
import { Principal } from "@icp-sdk/core/principal";

// ==========================================
// Shared design-system primitives
// (consumed by App.tsx and IdeaBoard.tsx)
// ==========================================

export const iconPaths: Record<string, React.ReactNode> = {
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
  edit: <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  chevDown: <path d="M6 9l6 6 6-6" />,
  chevRight: <path d="M9 18l6-6-6-6" />,
  chevLeft: <path d="M15 18l-6-6 6-6" />,
  zap: <path d="M13 2L3 14h8l-1 8 11-13h-8z" />,
  coins: <><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1110.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82" /></>,
  spark: <path d="M12 3l1.7 5.1a3 3 0 002.2 2.2L21 12l-5.1 1.7a3 3 0 00-2.2 2.2L12 21l-1.7-5.1a3 3 0 00-2.2-2.2L3 12l5.1-1.7a3 3 0 002.2-2.2z" />,
  wallet: <><path d="M19 7V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-2" /><path d="M14 12h7v-2a2 2 0 00-2-2h-5a2 2 0 00-2 2v2a2 2 0 002 2z" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 015 5v0a5 5 0 01-5 5H9" /></>,
  refresh: <><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 4v4h-4" /></>,
  bulb: <><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 00-3.7 10.7c.7.6 1.2 1.4 1.4 2.3h4.6c.2-.9.7-1.7 1.4-2.3A6 6 0 0012 3z" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="M14.8 9.2l-1.8 4.6-4.6 1.8 1.8-4.6z" /></>,
  gamepad: <><rect x="2" y="7" width="20" height="10" rx="5" /><path d="M7.5 10v4M5.5 12h4M15.5 10.5h.01M18 13h.01" /></>,
  sound: <><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" /></>,
  soundOff: <><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M22 9l-6 6M16 9l6 6" /></>,
};

export interface IconProps {
  name: string;
  size?: number;
  stroke?: string;
  sw?: number;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 16, stroke = 'currentColor', sw = 1.5, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block', ...style }}>
      {iconPaths[name]}
    </svg>
  );
}

// Discord's wordmark glyph is a filled shape, so it can't ride the stroke-only
// Icon set — render it standalone.
export function DiscordMark({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size * 0.78} viewBox="0 0 127.14 96.36" fill={color}
      style={{ flexShrink: 0, display: 'block' }} aria-hidden="true">
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/>
    </svg>
  );
}

export const DISCORD_INVITE = 'https://discord.gg/N7K2veuzV';

export function Eyebrow({ children, accent, style }: { children: React.ReactNode; accent?: boolean; style?: React.CSSProperties }) {
  return (
    <span className="mono" style={{
      fontSize: 10.5, fontWeight: 500, letterSpacing: '0.09em', textTransform: 'uppercase',
      color: accent ? 'var(--burn)' : 'var(--fg-3)', ...style
    }}>
      {children}
    </span>
  );
}

export const CHIP_TONES = {
  muted:   { bg: 'transparent',        bd: 'var(--border)',  fg: 'var(--fg-2)' },
  burn:    { bg: 'var(--burn-950)',    bd: 'var(--burn)',    fg: 'var(--burn)' },
  solid:   { bg: 'var(--burn)',        bd: 'var(--burn)',    fg: 'var(--char-950)' },
  ok:      { bg: 'var(--sprout-dim)',  bd: 'var(--sprout)',  fg: 'var(--sprout)' },
  danger:  { bg: 'var(--ember-dim)',   bd: 'var(--ember)',   fg: 'var(--ember)' },
  pending: { bg: 'var(--haze-dim)',    bd: 'var(--haze)',    fg: 'var(--haze)' },
  dashed:  { bg: 'transparent',        bd: 'var(--border-hi)', fg: 'var(--fg-3)' },
};

export function Chip({ tone = 'muted', children, style }: { tone?: keyof typeof CHIP_TONES; children: React.ReactNode; style?: React.CSSProperties }) {
  const c = CHIP_TONES[tone] || CHIP_TONES.muted;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px',
      borderRadius: 4, border: `1px solid ${c.bd}`, background: c.bg, color: c.fg,
      fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', lineHeight: 1,
      borderStyle: tone === 'dashed' ? 'dashed' : 'solid', ...style
    }}>
      {children}
    </span>
  );
}

export function Btn({ variant = 'secondary', sm, children, disabled, style, onClick }: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  sm?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  style?: React.CSSProperties;
  onClick?: () => void;
}) {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: sm ? 30 : 36, padding: sm ? '0 11px' : '0 15px', borderRadius: 6,
    fontFamily: 'var(--font-body)', fontSize: sm ? 12.5 : 13.5, fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
    transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
    opacity: disabled ? 0.4 : 1, border: 'none', ...style,
  };
  const skins = {
    primary:   { background: 'var(--burn)', color: 'var(--char-950)', border: '1px solid var(--burn)' },
    secondary: { background: 'transparent', color: 'var(--fg)', border: '1px solid var(--border-hi)' },
    ghost:     { background: 'transparent', color: 'var(--fg-2)', border: '1px solid transparent' },
    danger:    { background: 'transparent', color: 'var(--ember)', border: '1px solid var(--ember)' },
  };
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...skins[variant] }}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function LiveDot({ color = 'var(--burn)', size = 6, on = true, style }: { color?: string; size?: number; on?: boolean; style?: React.CSSProperties }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: 999, background: color,
      flexShrink: 0, animation: on ? 'il-pulse 2s var(--ease-in-out) infinite' : 'none', ...style
    }} />
  );
}

// Formatting helpers
export function fmtICP(n: number | bigint) {
  return (Number(n) / 100_000_000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 5 });
}

export function formatPrincipal(p: Principal | null): string {
  if (!p) return "anon";
  const s = p.toString();
  if (s === "2vxsx-fae") return "Anonymous";
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}
