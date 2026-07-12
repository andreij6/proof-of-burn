import { useEffect, useMemo, useState } from 'react';
import { LiveDot, formatPrincipal, DiscordMark, DISCORD_INVITE, BrandMark, OpenChatMark, OPENCHAT_URL } from './ui';
import type { LotteryInfo, LotteryDraw } from './bindings/backend';

type UsdRate = { token: string; rate_usd_e8s: bigint };

// ==========================================
// Landing — the No Loss Lottery, front and center.
//
// A dark "draw console" landing built from the Claude Design comp
// (Cycleburn.dc.html). Every number is real, pulled live from the canister
// (anonymous-allowlisted queries): the prize pool, next-draw countdown, total
// staked, draws held, recent winners, and the per-tier ticket odds. The CTAs
// drop the visitor straight onto the Lottery page (`onEnter`).
//
// What's *real* vs the comp's demo data: the comp invented 4yr/8yr neuron
// tiers and an "APY" row — the app actually has 6-month / 1-year / 2-year
// pooled tiers (base × {1,2,4} tickets per ICP per
// day), a 65% / 30% / 5% prize split, and draws 3× a week that only fire once
// the pot clears its minimum. This component reflects that.
// ==========================================

/** Feature-flag booleans (kept for API compatibility with App; the landing is
 *  now lottery-only so they no longer gate sections). */
export interface LandingFlags {
  staking: boolean;
  lottery: boolean;
  explorer: boolean;
}

interface LandingProps {
  /** Enter the app (App points this at the Lottery page). */
  onEnter: () => void;
  /** Anonymous backend actor for the live read-only queries. */
  actor?: any;
  flags?: LandingFlags;
}

// The real staking tiers (mirrors the in-app Lottery copy + backend grants):
// base 6-month grant × {1, 2, 4}. `tickets_per_day` from the canister is the
// 6-month base, so the table tracks any admin change to the base. (The
// permanent Booster neuron is admin-only and intentionally not shown here.)
const TIER_ROWS: { label: string; mult: number }[] = [
  { label: '6 months', mult: 1 },
  { label: '1 year', mult: 2 },
  { label: '2 years', mult: 4 },
];

const BACKEND_CANISTER_ID = 'k7dn6-qiaaa-aaaap-qutha-cai';
const X_URL = 'https://x.com/CalderaICP';

// ── formatters ─────────────────────────────────────────────────────────────
const e8sToIcp = (n: bigint) => Number(n) / 100_000_000;
/** "8,427.62" — 2dp, grouped. */
const fmt2 = (e8s: bigint) =>
  e8sToIcp(e8s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Compact ICP: "1.42M" / "24.8K" / "812". */
const fmtDate = (ns: bigint) =>
  new Date(Number(ns / 1_000_000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const pad = (n: number) => String(n).padStart(2, '0');
/** Countdown to an ns timestamp: "Dd HH:MM:SS" (drops the day part under 24h). */
function fmtCountdown(targetNs: bigint, nowMs: number): string {
  const ms = Number(targetNs / 1_000_000n) - nowMs;
  if (ms <= 0) return 'drawing…';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (d > 0 ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// shared style fragments
const MONO = 'var(--font-mono)';
const DISPLAY = 'var(--font-display)';
const BODY = 'var(--font-body)';
const EYEBROW: React.CSSProperties = { fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--burn)' };
const COL_HEAD: React.CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--fg-3)' };

export default function Landing({ onEnter, actor }: LandingProps) {
  const [info, setInfo] = useState<LotteryInfo | null>(null);
  const [winners, setWinners] = useState<LotteryDraw[]>([]);
  const [icpUsdE8s, setIcpUsdE8s] = useState<bigint>(0n);
  const [promoOpen, setPromoOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  // Live reads (all anonymous-allowlisted). Best-effort: a failure leaves the
  // section showing "—" rather than blanking the page.
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    (async () => {
      const [i, w, rates, market] = await Promise.all([
        actor.get_lottery_info().catch(() => null),
        actor.list_recent_winners().catch(() => [] as LotteryDraw[]),
        actor.get_usd_rates().catch(() => [] as UsdRate[]),
        actor.get_bond_market().catch(() => null),
      ]);
      if (cancelled) return;
      setInfo(i);
      setWinners(w ?? []);
      setPromoOpen(!!market?.promo_open);
      const icp = (rates ?? []).find((r: UsdRate) => r.token === 'ICP');
      setIcpUsdE8s(icp?.rate_usd_e8s ?? 0n);
    })();
    return () => { cancelled = true; };
  }, [actor]);

  // 1s tick for the live countdown.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const cd = info ? fmtCountdown(info.next_draw_at, nowMs) : '—';
  const poolStr = info ? fmt2(info.pot_e8s) : '—';
  const poolUsd = info && icpUsdE8s > 0n
    ? '$' + Math.round(e8sToIcp(info.pot_e8s) * (Number(icpUsdE8s) / 1e8)).toLocaleString('en-US')
    : '';
  // A draw only fires when BOTH gates clear: the pot meets its minimum AND
  // enough distinct people hold tickets. Each gets its own progress bar.
  const potPct = info && info.min_pot_e8s > 0n
    ? Math.min(100, Math.round((Number(info.pot_e8s) / Number(info.min_pot_e8s)) * 100))
    : 100;
  const minHolders = info ? Number(info.min_unique_holders) : 0;
  const playersPct = info ? (minHolders > 0 ? Math.min(100, Math.round((Number(info.unique_holders) / minHolders) * 100)) : 100) : 0;
  const baseTicket = info ? Number(info.tickets_per_day) : 0;

  const recentWins = useMemo(
    () => [...winners].filter(d => d.winner).sort((a, b) => Number(b.drawn_at - a.drawn_at)).slice(0, 5),
    [winners],
  );

  const stat = (v: string, label: string) => (
    <div>
      <span style={{ fontFamily: MONO, fontSize: 16, color: 'var(--fg)' }}>{v}</span>{' '}
      <span style={{ fontSize: 13, color: 'var(--fg-3)' }}>{label}</span>
    </div>
  );

  const primaryBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer',
    fontFamily: BODY, fontWeight: 600, borderRadius: 8, border: '1px solid transparent',
    height: 48, padding: '0 24px', fontSize: 15, background: 'var(--burn)', color: 'var(--char-950)',
    whiteSpace: 'nowrap',
  };
  const ghostBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: BODY, fontWeight: 600,
    borderRadius: 8, border: '1px solid var(--char-800)', height: 48, padding: '0 22px', fontSize: 15,
    background: 'var(--char-900)', color: 'var(--fg)',
  };

  return (
    // The landing is always a dark surface. Pin the dark-palette foreground vars
    // so text stays light even when the app runs in light mode (which otherwise
    // flips --fg/--fg-1/--fg-2/--fg-3 to near-black via [data-theme="light"]).
    // These cascade to every child through CSS-variable inheritance. The
    // --char-*/--burn/--sprout fills are theme-invariant, so they need no override.
    <div style={{
      background: 'var(--char-950)', minHeight: '100vh',
      ['--fg' as string]: '#FAF9F7',
      ['--fg-1' as string]: '#F5F4F2',
      ['--fg-2' as string]: '#A8A29E',
      ['--fg-3' as string]: '#78716C',
    } as React.CSSProperties}>
      {/* ===== NAV ===== */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 50, height: 56, background: 'rgba(12,10,9,0.82)', backdropFilter: 'blur(8px)', borderBottom: '1px solid var(--char-800)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', height: '100%', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 34 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandMark size={24} />
            <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 18, letterSpacing: '-.02em', color: 'var(--fg)' }}>Cycle Burn</span>
          </div>
          <div className="ll-nav-links" style={{ display: 'flex', gap: 24, marginLeft: 6 }}>
            <a href="#how" style={{ color: 'var(--fg-2)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>How it works</a>
            <a href="#odds" style={{ color: 'var(--fg-2)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>Odds</a>
            <a href="#winners" style={{ color: 'var(--fg-2)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>Winners</a>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--fg-3)', letterSpacing: '.04em', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <LiveDot size={6} /> next draw {cd}
            </span>
            <button onClick={onEnter} style={{ ...primaryBtn, height: 34, padding: '0 14px', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}>Launch app →</button>
          </div>
        </div>
      </nav>

      {/* ===== HERO · DRAW CONSOLE ===== */}
      <section style={{ borderBottom: '1px solid var(--char-800)', backgroundImage: 'repeating-linear-gradient(to bottom,transparent 0 23px,var(--char-800) 23px 24px)' }}>
        <div className="ll-hero-grid" style={{ maxWidth: 1180, margin: '0 auto', padding: '88px 24px 96px' }}>
          {/* left */}
          <div>
            <div style={EYEBROW}>no-loss lottery · on ICP</div>
            <h1 className="ll-hero-title" style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 72, lineHeight: 1.0, letterSpacing: '-.03em', color: 'var(--fg)', margin: '18px 0 0', textWrap: 'balance' }}>Save. Stake.<br />Maybe win it all.</h1>
            <p style={{ fontSize: 18, lineHeight: 1.55, color: 'var(--fg-2)', maxWidth: 440, margin: '22px 0 0' }}>Stake ICP, earn tickets every day, and the network's staking yield becomes the prize. Win the pool or don't — you keep 100% of your principal either way.</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 30, flexWrap: 'wrap' }}>
              <button onClick={onEnter} style={primaryBtn}>Stake ICP →</button>
              <a href="#odds" style={{ ...ghostBtn, textDecoration: 'none' }}>Read the odds</a>
            </div>
            {promoOpen && (
              <a href="#/claim" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 14, fontWeight: 600, color: 'var(--haze)', textDecoration: 'none' }}>
                <span aria-hidden>🎟</span> Claim a free Golden Ticket →
              </a>
            )}
            {/* Value facts, not live counts — scale numbers stay off the
                landing until there's scale worth showing. */}
            <div style={{ display: 'flex', gap: 28, marginTop: 38, flexWrap: 'wrap' }}>
              {stat('3×', 'draws weekly')}
              {stat('65%', 'to the winner')}
              {stat('100%', 'principal kept')}
            </div>
          </div>

          {/* right: console */}
          <div style={{ background: 'var(--char-900)', border: '1px solid var(--burn)', borderRadius: 12, padding: 24, boxShadow: '0 12px 32px -8px rgba(0,0,0,.45)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={COL_HEAD}>next draw</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--burn)', letterSpacing: '.08em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 6 }}><LiveDot size={6} /> live</span>
            </div>
            <div style={{ ...COL_HEAD, marginTop: 22 }}>prize pool</div>
            <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 52, lineHeight: 1, color: 'var(--burn)', letterSpacing: '-.03em', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{poolStr}</div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: 'var(--fg-2)', marginTop: 6 }}>ICP{poolUsd ? ` · ${poolUsd}` : ''}</div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 22 }}>
              <span style={COL_HEAD}>draws in</span>
              <span style={{ fontFamily: MONO, fontSize: 22, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{cd}</span>
            </div>
            {/* Two draw gates — both must clear before a draw fires. */}
            <div style={{ ...COL_HEAD, marginTop: 16 }}>both gates must clear to draw</div>
            {([
              { pct: potPct, cap: info ? `pot · ${fmt2(info.pot_e8s)} / ${fmt2(info.min_pot_e8s)} ICP` : 'pot vs. minimum' },
              { pct: playersPct, cap: 'players vs. minimum' },
            ] as const).map((g, i) => (
              <div key={i} style={{ marginTop: i === 0 ? 10 : 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--fg-3)' }}>{g.cap}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: g.pct >= 100 ? 'var(--sprout)' : 'var(--fg-3)' }}>{g.pct}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 999, background: 'var(--char-800)', marginTop: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${g.pct}%`, background: g.pct >= 100 ? 'var(--sprout)' : 'var(--burn)' }} />
                </div>
              </div>
            ))}

            <button onClick={onEnter} style={{ ...primaryBtn, width: '100%', marginTop: 22, height: 44, borderTop: '1px solid transparent' }}>Stake to get tickets →</button>
          </div>
        </div>
      </section>

      {/* ===== HOW IT WORKS ===== */}
      <section id="how" style={{ borderBottom: '1px solid var(--char-800)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '96px 24px' }}>
          <div style={EYEBROW}>how it works</div>
          <h2 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 48, lineHeight: 1.05, letterSpacing: '-.03em', color: 'var(--fg)', margin: '12px 0 44px', maxWidth: 680 }}>Stake. Earn tickets. Win the yield.</h2>
          <div className="ll-how-grid" style={{ borderTop: '1px solid var(--char-800)', borderBottom: '1px solid var(--char-800)' }}>
            {[
              { n: '01', h: 'Stake into a neuron', b: "Lock ICP into a pooled Cycle Burn neuron — choose a 6-month, 1-year, or 2-year term. Your principal always stays yours." },
              { n: '02', h: 'Earn tickets daily', b: "Tickets mint every day you're staked. The longer the term, the more you earn per ICP — up to 4× — and the better your odds." },
              { n: '03', h: 'Win the yield', b: "Three times a week the pooled neuron yield is drawn: 65% to one winner, 30% rolls into the next pot, 5% is burned. Lose and you keep every staked token — there's no losing." },
            ].map((c, i) => (
              <div key={c.n} style={{ padding: '36px 26px', borderRight: i < 2 ? '1px solid var(--char-800)' : undefined }}>
                <div style={{ fontFamily: MONO, fontSize: 13, color: 'var(--burn)' }}>{c.n}</div>
                <h3 style={{ fontFamily: DISPLAY, fontSize: 26, fontWeight: 600, letterSpacing: '-.02em', color: 'var(--fg)', margin: '16px 0 10px' }}>{c.h}</h3>
                <p style={{ color: 'var(--fg-2)', fontSize: 15, lineHeight: 1.5, margin: 0 }}>{c.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== ODDS & PRIZE BREAKDOWN ===== */}
      <section id="odds" style={{ borderBottom: '1px solid var(--char-800)', background: 'var(--char-925)' }}>
        <div className="ll-two-col" style={{ maxWidth: 1200, margin: '0 auto', padding: '96px 24px' }}>
          <div>
            <div style={EYEBROW}>odds</div>
            <h2 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 40, lineHeight: 1.05, letterSpacing: '-.03em', color: 'var(--fg)', margin: '12px 0 28px' }}>Longer term, more tickets.</h2>
            <div style={{ border: '1px solid var(--char-800)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr .8fr', padding: '13px 18px', background: 'var(--char-900)', borderBottom: '1px solid var(--char-800)' }}>
                <span style={COL_HEAD}>stake term</span>
                <span style={COL_HEAD}>tickets / day · per ICP</span>
                <span style={{ ...COL_HEAD, textAlign: 'right' }}>odds</span>
              </div>
              {TIER_ROWS.map((t, i) => {
                const perDay = baseTicket > 0 ? baseTicket * t.mult : null;
                const last = i === TIER_ROWS.length - 1;
                return (
                  <div key={t.label} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr .8fr', padding: '14px 18px', borderBottom: last ? undefined : '1px solid var(--char-800)', background: last ? 'var(--burn-950)' : (i % 2 === 1 ? 'var(--char-925)' : undefined) }}>
                    <span style={{ fontSize: 14, color: 'var(--fg)', fontWeight: last ? 500 : 400 }}>{t.label}</span>
                    <span style={{ fontFamily: MONO, fontSize: 14, color: last ? 'var(--burn)' : 'var(--fg)' }}>{perDay ?? '—'}</span>
                    <span style={{ fontFamily: MONO, fontSize: 14, color: last ? 'var(--burn)' : 'var(--fg-2)', textAlign: 'right' }}>{t.mult}×</span>
                  </div>
                );
              })}
            </div>
            <p style={{ color: 'var(--fg-3)', fontSize: 13, lineHeight: 1.5, margin: '14px 0 0' }}>Unstake any time — you only stop earning new tickets. Your ICP returns to you once the neuron finishes dissolving; it's never spent.</p>
          </div>

          <div style={{ border: '1px solid var(--char-800)', borderRadius: 12, background: 'var(--char-900)', padding: 32 }}>
            <div style={EYEBROW}>prize breakdown</div>
            <h3 style={{ fontFamily: DISPLAY, fontSize: 26, fontWeight: 600, letterSpacing: '-.02em', color: 'var(--fg)', margin: '14px 0 18px' }}>Where the jackpot comes from</h3>
            <p style={{ color: 'var(--fg-2)', fontSize: 15, lineHeight: 1.55, margin: '0 0 22px' }}>No one funds the prize but the network. Every pooled neuron's maturity yield flows into one pot — nobody's stake is ever spent, only the yield is at stake.</p>
            <div style={{ display: 'grid', gap: 14 }}>
              {[
                { k: 'Paid out to date', v: info ? `${fmt2(info.total_paid_e8s)} ICP` : '—', c: 'var(--sprout)' },
                { k: "This draw's prize", v: info ? `${poolStr} ICP` : '—', c: 'var(--burn)' },
              ].map(r => (
                <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--char-800)', paddingTop: 14 }}>
                  <span style={{ fontSize: 14, color: 'var(--fg-2)' }}>{r.k}</span>
                  <span style={{ fontFamily: MONO, fontSize: 18, color: r.c, fontVariantNumeric: 'tabular-nums' }}>{r.v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== RECENT WINNERS ===== (hidden until the history reads as
          social proof — 5+ draws — rather than as emptiness) */}
      {info && Number(info.draws_held) >= 5 && (
      <section id="winners" style={{ borderBottom: '1px solid var(--char-800)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '96px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28, gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={EYEBROW}>recent draws</div>
              <h2 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 40, lineHeight: 1.05, letterSpacing: '-.03em', color: 'var(--fg)', margin: '10px 0 0' }}>No house. Just winners.</h2>
            </div>
            <button onClick={onEnter} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-2)', fontSize: 14, fontFamily: BODY }}>
              All draws →
            </button>
          </div>
          <div className="ll-table-wrap" style={{ border: '1px solid var(--char-800)', borderRadius: 8, overflow: 'hidden' }}>
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '.7fr 1fr 1.4fr 1fr 1fr', padding: '13px 20px', background: 'var(--char-900)', borderBottom: '1px solid var(--char-800)' }}>
                <span style={COL_HEAD}>draw</span>
                <span style={COL_HEAD}>date</span>
                <span style={COL_HEAD}>winner</span>
                <span style={COL_HEAD}>entries</span>
                <span style={{ ...COL_HEAD, textAlign: 'right' }}>prize</span>
              </div>
              {recentWins.length === 0 ? (
                <div style={{ padding: '22px 20px', color: 'var(--fg-3)', fontSize: 13 }}>
                  {info ? 'No draws yet — be the first to stake and seed the pot.' : 'Loading recent draws…'}
                </div>
              ) : recentWins.map((d, i) => (
                <div key={Number(d.id)} style={{ display: 'grid', gridTemplateColumns: '.7fr 1fr 1.4fr 1fr 1fr', padding: '15px 20px', borderBottom: i < recentWins.length - 1 ? '1px solid var(--char-800)' : undefined, background: i % 2 === 1 ? 'var(--char-925)' : undefined }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--burn)' }}>#{Number(d.id)}</span>
                  <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{fmtDate(d.drawn_at)}</span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--fg-1)' }}>{formatPrincipal(d.winner ?? null)}</span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--fg-2)' }}>{Number(d.total_tickets).toLocaleString('en-US')}</span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--fg)', textAlign: 'right' }}>{fmt2(d.prize_e8s)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      )}

      {/* ===== CTA ===== */}
      <section style={{ position: 'relative', borderBottom: '1px solid var(--char-800)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(to bottom,transparent 0 23px,var(--char-800) 23px 24px)', opacity: .5 }} />
        <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto', padding: '88px 24px', textAlign: 'center' }}>
          <h2 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 56, lineHeight: 1.02, letterSpacing: '-.03em', color: 'var(--fg)', margin: 0, textWrap: 'balance' }}>Stake once. Enter every draw.</h2>
          <p style={{ fontSize: 18, lineHeight: 1.5, color: 'var(--fg-2)', maxWidth: 480, margin: '18px auto 0' }}>
            {info ? <>The pot is at <b style={{ color: 'var(--fg-1)' }}>{poolStr} ICP</b> and the next draw is in <b style={{ color: 'var(--fg-1)' }}>{cd}</b>. Your principal is never at risk.</> : "Stake losslessly, earn daily tickets, and win the network's yield. Your principal is never at risk."}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 30, flexWrap: 'wrap' }}>
            <button onClick={onEnter} style={{ ...primaryBtn, padding: '0 26px' }}>Stake ICP →</button>
            <a href="#how" style={{ ...ghostBtn, textDecoration: 'none' }}>How it works</a>
          </div>
        </div>
      </section>

      {/* ===== FOOTER ===== */}
      <footer style={{ padding: '48px 24px 40px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 40, paddingBottom: 36, borderBottom: '1px solid var(--char-800)', flexWrap: 'wrap' }}>
            <div style={{ maxWidth: 300 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <BrandMark size={22} />
                <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 17, letterSpacing: '-.02em', color: 'var(--fg)' }}>Cycle Burn</span>
              </div>
              <p style={{ color: 'var(--fg-3)', fontSize: 13, lineHeight: 1.5, margin: '14px 0 0' }}>A no-loss lottery on the Internet Computer. Stake, earn tickets, win the yield — keep your principal.</p>
            </div>
            <div style={{ display: 'flex', gap: 56, flexWrap: 'wrap' }}>
              <div>
                <div style={{ ...COL_HEAD, marginBottom: 12 }}>Protocol</div>
                {[['How it works', '#how'], ['Odds', '#odds'], ['Winners', '#winners'], ['Developer docs', '#/dev-docs']].map(([t, href]) => (
                  <div key={t} style={{ marginBottom: 8 }}><a href={href} style={{ fontSize: 13, color: 'var(--fg-1)', textDecoration: 'none' }}>{t}</a></div>
                ))}
              </div>
              <div>
                <div style={{ ...COL_HEAD, marginBottom: 12 }}>Community</div>
                <div style={{ marginBottom: 8 }}><a href={X_URL} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--fg-1)', textDecoration: 'none' }}>X</a></div>
                <div style={{ marginBottom: 8 }}><a href={DISCORD_INVITE} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fg-1)', textDecoration: 'none' }}><DiscordMark size={13} color="currentColor" /> Discord</a></div>
                <div style={{ marginBottom: 8 }}><a href={OPENCHAT_URL} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fg-1)', textDecoration: 'none' }}><OpenChatMark size={13} color="currentColor" /> OpenChat</a></div>
              </div>
            </div>
          </div>
          <div style={{ paddingTop: 22, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--fg-3)' }}>© 2026 Cycle Burn · Built on ICP</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--fg-3)' }}>canister · {BACKEND_CANISTER_ID}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
