/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Read the live stylesheet at test time so this stays a real regression guard
// (Vite's `?raw` loader returns "" for .css under vitest, so use fs directly).
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'),
  'utf8',
);

// ── WCAG 2.2 relative-luminance / contrast-ratio math (SC 1.4.3 / 1.4.11) ────
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function lum(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: string, b: string): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── Parse the design tokens straight out of index.css ────────────────────────
// Parsing the live stylesheet makes this a real regression guard: the moment a
// token value is changed to something that no longer clears its threshold the
// test fails. This is Tier 3 of the light-mode-contrast plan.
const LIGHT_START = css.indexOf('[data-theme="light"]');
const ROOT = css.slice(0, LIGHT_START);
const LIGHT = (() => {
  const open = css.indexOf('{', LIGHT_START);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
})();

/** Resolve a token to a literal #hex within a scope, following var() chains. */
function tokenHex(name: string, scope: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(scope);
  const raw = m ? m[1].trim() : '';
  if (raw.startsWith('#')) return raw.slice(0, 7);
  const ref = /var\(--([\w-]+)\)/.exec(raw);
  if (ref) return tokenHex(ref[1], ROOT);
  throw new Error(`could not resolve token --${name}`);
}

/** Resolve a token honoring the [data-theme=light] override when present. */
function tokenHexInTheme(name: string, theme: 'dark' | 'light'): string {
  if (theme === 'light' && new RegExp(`--${name}:`).test(LIGHT)) {
    return tokenHex(name, LIGHT);
  }
  return tokenHex(name, ROOT);
}

function surfaceHex(name: string, theme: 'dark' | 'light'): string {
  return tokenHexInTheme(name, theme);
}

const SURFACES = ['bg', 'surface', 'bg-alt'] as const;

interface Case { token: string; min: number; label: string }

// Foreground text — must clear 4.5:1 against every page surface.
const FG_TEXT: Case[] = [
  { token: 'fg', min: 4.5, label: 'primary text' },
  { token: 'fg-1', min: 4.5, label: 'body text' },
  { token: 'fg-2', min: 4.5, label: 'secondary text' },
  { token: 'fg-3', min: 4.5, label: 'muted text' },
];

// Accent ink — used as text/icon foreground; 4.5:1 is the stricter (text) bar.
const INK: Case[] = [
  { token: 'burn-ink', min: 4.5, label: 'burn ink' },
  { token: 'sprout-ink', min: 4.5, label: 'sprout ink' },
  { token: 'haze-ink', min: 4.5, label: 'haze ink' },
];

// Meaningful, non-text divider — 3:1 (SC 1.4.11).
const UI: Case[] = [{ token: 'border-hi', min: 3, label: 'meaningful divider' }];

function assertClears(token: string, theme: 'dark' | 'light', surface: string, min: number) {
  const fg = tokenHexInTheme(token, theme);
  const bg = surfaceHex(surface, theme);
  const r = ratio(fg, bg);
  expect(r, `--${token} on --${surface} (${theme}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
}

// ── Light mode is what the plan fixed: full AA on text + accents + dividers ──
describe('light mode — WCAG 2.2 AA', () => {
  for (const c of [...FG_TEXT, ...INK, ...UI]) {
    for (const s of SURFACES) {
      it(`${c.label} (--${c.token}) on --${s} clears ${c.min}:1`, () => {
        assertClears(c.token, 'light', s, c.min);
      });
    }
  }
});

// ── Dark mode regressions: -ink accents (the migration target) + high-contrast
//    body text must still pass. (Dark muted greys --fg-3/--border-hi are the
//    pre-existing decorative/muted values the plan leaves as-is, so they are
//    not asserted here.) ──────────────────────────────────────────────────────
describe('dark mode — accents + body text still pass (no regression)', () => {
  for (const c of [...INK, { token: 'fg', min: 4.5, label: 'primary text' }, { token: 'fg-1', min: 4.5, label: 'body text' }, { token: 'fg-2', min: 4.5, label: 'secondary text' }]) {
    for (const s of SURFACES) {
      it(`${c.label} (--${c.token}) on --${s} clears ${c.min}:1`, () => {
        assertClears(c.token, 'dark', s, c.min);
      });
    }
  }
});

describe('-ink invariants', () => {
  it('equal the bright accent in dark mode (dark provably unchanged)', () => {
    expect(tokenHexInTheme('burn-ink', 'dark')).toBe(tokenHex('burn', ROOT));
    expect(tokenHexInTheme('sprout-ink', 'dark')).toBe(tokenHex('sprout', ROOT));
    expect(tokenHexInTheme('haze-ink', 'dark')).toBe(tokenHex('haze', ROOT));
  });
  it('are darkened (different) in light mode', () => {
    expect(tokenHexInTheme('burn-ink', 'light')).not.toBe(tokenHex('burn', ROOT));
    expect(tokenHexInTheme('sprout-ink', 'light')).not.toBe(tokenHex('sprout', ROOT));
    expect(tokenHexInTheme('haze-ink', 'light')).not.toBe(tokenHex('haze', ROOT));
  });
});
