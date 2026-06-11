import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, Btn, DiscordMark, DISCORD_INVITE } from './ui';

// ==========================================
// Landing — the value proposition as a neural transmission.
// One signal leaves a neuron at the top of the page and travels an axon down
// the screen as the user scrolls; every synapse it crosses lights up one
// feature of the protocol, and the message "arrives" at a second neuron with
// the final call to action. Inspired by fluorescence-microscopy neuron
// imagery (MIT News, 2017): glowing green dendrites on black, with the
// design system's burn-orange as the traveling action potential.
// ==========================================

interface LandingProps {
  onEnter: () => void;
}

const SECTIONS = [
  {
    icon: 'flame',
    eyebrow: 'NNS Voting',
    title: 'Burn ICP. Move the vote.',
    body: 'Commit ICP behind adopt or reject on live NNS proposals. The heavier side steers the community leader neuron. The vote lands — the pot burns into cycles and treasury. The threshold misses — every e8 comes straight back.',
    chips: ['1 ICP minimum', 'majority steers the neuron', 'full refund on a miss'],
  },
  {
    icon: 'zap',
    eyebrow: 'Staked Voting',
    title: 'Lock time. Multiply your voice.',
    body: 'Stake into 6-month, 1-year or 2-year pooled neurons. Voting power is your staked ICP ÷ 10 (10 staked = 1 burned of weight), longer terms earn more lottery tickets, and the treasury pays every transfer fee. Commit X, get X back. Zero loss, literally.',
    chips: ['10 staked ICP = 1 VP', 'principal never spent', 'treasury pays the fees'],
  },
  {
    icon: 'target',
    eyebrow: 'Lossless Lottery',
    title: 'Powerball odds. Nobody loses.',
    body: 'Stakers collect free tickets daily — 5, 10 or 20 by term. Three drawings a week at real 1-in-292,201,338 jackpot odds, with a pot funded purely by staking yield. Win, and 80% lands in your wallet automatically.',
    chips: ['3 drawings a week', '80% jackpot · 20% rolls over', 'paid instantly, no claiming'],
  },
  {
    icon: 'bulb',
    eyebrow: 'Community R&D',
    title: 'Pitch it. Back it. Get paid.',
    body: 'Post ideas that burn more ICP and earn 25% of every upvote they attract — in ICP, ckBTC or ckETH. Back the ideas you want to survive, and fund the projects the treasury executes.',
    chips: ['25% of upvotes to the poster', '3 tokens accepted', 'treasury-funded builds'],
  },
  {
    icon: 'copy',
    eyebrow: 'Built for agents',
    title: 'Your agent runs the routine.',
    body: 'Every flow ships as a copy-paste skill: vote on proposals, stake, claim lottery tickets, defend your ideas. Hand the daily loop to an AI agent — you keep the upside.',
    chips: ['copy-paste agent skills', 'CLI-first endpoints', 'cron-friendly daily claims'],
  },
] as const;

/** Deterministic pseudo-random for the background "tissue" specks. */
function speck(i: number) {
  const x = ((i * 73) % 97) / 97;
  const y = ((i * 151) % 89) / 89;
  const r = 0.8 + ((i * 29) % 10) / 8;
  const o = 0.05 + ((i * 41) % 12) / 110;
  return { x, y, r, o };
}

/** A stylized soma: glowing cell body with radiating dendrites. */
function Soma({ x, y, lit, flip }: { x: number; y: number; lit: boolean; flip?: boolean }) {
  const dendrites = [-150, -110, -65, -20, 30, 75, 120].map((deg, i) => {
    const a = ((deg + (flip ? 180 : 0)) * Math.PI) / 180;
    const len = 70 + (i % 3) * 34;
    const mx = x + Math.cos(a) * len * 0.5 + Math.sin(a) * 16;
    const my = y + Math.sin(a) * len * 0.5 - Math.cos(a) * 16;
    const ex = x + Math.cos(a) * len;
    const ey = y + Math.sin(a) * len;
    return `M ${x} ${y} Q ${mx} ${my} ${ex} ${ey}`;
  });
  return (
    <g style={{ transition: 'opacity 600ms ease' }} opacity={lit ? 1 : 0.45}>
      <circle cx={x} cy={y} r={64} fill="url(#somaHalo)" opacity={lit ? 0.9 : 0.35} />
      {dendrites.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--sprout)" strokeOpacity={0.55}
          strokeWidth={2.2 - (i % 3) * 0.5} strokeLinecap="round" />
      ))}
      <circle cx={x} cy={y} r={17} fill="url(#somaCore)" filter="url(#glow)" />
      <circle cx={x} cy={y} r={6.5} fill="#FDF6E3" opacity={lit ? 0.95 : 0.6} />
    </g>
  );
}

export default function Landing({ onEnter }: LandingProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const anchorRefs = useRef<(HTMLDivElement | null)[]>([]);
  const brightRef = useRef<SVGPathElement>(null);
  const pulseRef = useRef<SVGGElement>(null);

  const [geom, setGeom] = useState<{
    w: number; h: number; d: string; anchors: { x: number; y: number }[];
  } | null>(null);
  const [pathLen, setPathLen] = useState(0);
  const [anchorLens, setAnchorLens] = useState<number[]>([]);
  const [progress, setProgress] = useState(0);

  // ── Measure the page and build the axon path through every anchor ──
  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.scrollHeight;
    const cx = w / 2;
    const wide = w > 760;
    const offset = wide ? Math.min(w * 0.17, 210) : 0;

    const crect = el.getBoundingClientRect();
    const anchors = anchorRefs.current
      .filter((a): a is HTMLDivElement => !!a)
      .map((a, i, all) => {
        const r = a.getBoundingClientRect();
        const y = r.top - crect.top + r.height / 2;
        // Hero (0) and finale (last) sit on the centerline. Feature synapse i
        // swings OPPOSITE its content card: even sections card-left → node
        // right, odd sections card-right → node left.
        const isEnd = i === 0 || i === all.length - 1;
        const x = isEnd ? cx : cx + (i % 2 === 1 ? offset : -offset);
        return { x, y };
      });
    if (anchors.length < 2) return;

    let d = `M ${anchors[0].x} ${anchors[0].y}`;
    for (let i = 1; i < anchors.length; i++) {
      const p = anchors[i - 1];
      const q = anchors[i];
      const my = (p.y + q.y) / 2;
      d += ` C ${p.x} ${my} ${q.x} ${my} ${q.x} ${q.y}`;
    }
    setGeom({ w, h, d, anchors });

    // Total + per-anchor lengths via a detached path element.
    const ns = 'http://www.w3.org/2000/svg';
    const probe = document.createElementNS(ns, 'path');
    if (typeof probe.getTotalLength !== 'function') {
      // Environment without SVG geometry (jsdom etc.) — static art only.
      setPathLen(0);
      setAnchorLens([]);
      return;
    }
    probe.setAttribute('d', d);
    const total = probe.getTotalLength();
    setPathLen(total);
    const lens: number[] = [0];
    let acc = `M ${anchors[0].x} ${anchors[0].y}`;
    for (let i = 1; i < anchors.length; i++) {
      const p = anchors[i - 1];
      const q = anchors[i];
      const my = (p.y + q.y) / 2;
      acc += ` C ${p.x} ${my} ${q.x} ${my} ${q.x} ${q.y}`;
      probe.setAttribute('d', acc);
      lens.push(probe.getTotalLength());
    }
    setAnchorLens(lens);
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);

  // ── Drive the action potential from scroll position ──
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      setProgress(p);
      const bright = brightRef.current;
      const pulse = pulseRef.current;
      if (bright && pathLen > 0 && typeof bright.getPointAtLength === 'function') {
        bright.style.strokeDashoffset = String(pathLen * (1 - p));
        if (pulse) {
          const pt = bright.getPointAtLength(pathLen * p);
          pulse.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
        }
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [pathLen]);

  // ── Section reveal on approach ──
  const [seen, setSeen] = useState<boolean[]>(() => SECTIONS.map(() => false));
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const idx = Number((e.target as HTMLElement).dataset.idx);
          setSeen((prev) => (prev[idx] ? prev : prev.map((v, i) => (i === idx ? true : v))));
        });
      },
      { threshold: 0.25 }
    );
    sectionRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const traveled = pathLen * progress;
  const arrived = progress > 0.96;
  const card: React.CSSProperties = {
    background: 'color-mix(in srgb, var(--char-950) 78%, transparent)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: '26px 28px',
    backdropFilter: 'blur(6px)',
    maxWidth: 480,
  };

  return (
    <div ref={containerRef} style={{
      position: 'relative', background: 'var(--char-950)', color: 'var(--fg)',
      overflowX: 'clip', minHeight: '100vh',
    }}>
      {/* ── Fixed minimal chrome: logo + Go to App, always reachable ── */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 5,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 22px',
        background: 'linear-gradient(color-mix(in srgb, var(--char-950) 88%, transparent), transparent)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>
          <Icon name="flame" size={16} stroke="var(--burn)" /> Cycles of Influence
        </span>
        <Btn variant="primary" sm onClick={onEnter}>
          Go to App <Icon name="chevRight" size={13} stroke="var(--char-950)" />
        </Btn>
      </div>

      {/* ── The tissue: axon, somas, synapses, ambient specks ── */}
      {geom && (
        <svg
          width={geom.w} height={geom.h} viewBox={`0 0 ${geom.w} ${geom.h}`}
          style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="somaCore">
              <stop offset="0%" stopColor="#FDF6E3" />
              <stop offset="45%" stopColor="var(--haze)" />
              <stop offset="100%" stopColor="var(--sprout)" />
            </radialGradient>
            <radialGradient id="somaHalo">
              <stop offset="0%" stopColor="var(--sprout)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--sprout)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="pulseHalo">
              <stop offset="0%" stopColor="var(--burn)" stopOpacity="0.9" />
              <stop offset="100%" stopColor="var(--burn)" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="axonLit" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--sprout)" />
              <stop offset="100%" stopColor="var(--burn)" />
            </linearGradient>
            <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge>
                <feMergeNode in="b" /><feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* ambient neural tissue */}
          {Array.from({ length: 70 }, (_, i) => {
            const sp = speck(i);
            return <circle key={i} cx={sp.x * geom.w} cy={sp.y * geom.h} r={sp.r}
              fill="var(--sprout)" opacity={sp.o} />;
          })}

          {/* resting axon (myelinated look: faint double stroke) */}
          <path d={geom.d} fill="none" stroke="var(--sprout)" strokeOpacity={0.14} strokeWidth={7} strokeLinecap="round" />
          <path d={geom.d} fill="none" stroke="var(--sprout)" strokeOpacity={0.30} strokeWidth={1.6}
            strokeDasharray="2 9" strokeLinecap="round" />

          {/* depolarized (traveled) portion */}
          <path
            ref={brightRef}
            d={geom.d} fill="none" stroke="url(#axonLit)" strokeWidth={2.8}
            strokeLinecap="round" filter="url(#glow)"
            strokeDasharray={pathLen} strokeDashoffset={pathLen * (1 - progress)}
            opacity={0.95}
          />

          {/* synapse nodes per feature section */}
          {geom.anchors.slice(1, -1).map((a, i) => {
            const lit = anchorLens.length > i + 1 && traveled >= anchorLens[i + 1] - 2;
            return (
              <g key={i} style={{ transition: 'opacity 400ms ease' }}>
                {lit && <circle cx={a.x} cy={a.y} r={22} fill="url(#pulseHalo)" opacity={0.55} />}
                <circle cx={a.x} cy={a.y} r={7} fill={lit ? 'var(--burn)' : 'var(--char-950)'}
                  stroke={lit ? 'var(--burn)' : 'var(--sprout)'} strokeOpacity={lit ? 1 : 0.5}
                  strokeWidth={1.6} filter={lit ? 'url(#glow)' : undefined} />
              </g>
            );
          })}

          {/* origin + destination neurons */}
          <Soma x={geom.anchors[0].x} y={geom.anchors[0].y} lit={true} />
          <Soma x={geom.anchors[geom.anchors.length - 1].x} y={geom.anchors[geom.anchors.length - 1].y}
            lit={arrived} flip />

          {/* the action potential */}
          <g ref={pulseRef} transform={`translate(${geom.anchors[0].x} ${geom.anchors[0].y})`}>
            <circle r={20} fill="url(#pulseHalo)">
              <animate attributeName="r" values="14;24;14" dur="1.6s" repeatCount="indefinite" />
            </circle>
            <circle r={5} fill="#FFF3E8" filter="url(#glow)" />
          </g>
        </svg>
      )}

      {/* ── Hero: the message leaves the first neuron ── */}
      <section style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        position: 'relative', zIndex: 1, padding: '90px 20px 40px', gap: 18,
      }}>
        <span style={{
          fontSize: 11.5, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--sprout)', fontWeight: 600,
        }}>
          Internet Computer governance, with skin in the game
        </span>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'clamp(34px, 6vw, 64px)',
          lineHeight: 1.06, margin: 0, maxWidth: 760, textWrap: 'balance',
        }}>
          Your conviction is a signal.<br />
          <span style={{ color: 'var(--burn)' }}>Transmit it.</span>
        </h1>
        <p style={{ fontSize: 15.5, lineHeight: 1.6, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
          Burn ICP to steer NNS votes. Stake to multiply your voice — at zero cost.
          Win a yield-funded lottery nobody pays into. One protocol, every incentive pointed
          at the same thing: a louder, sharper Internet Computer.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Btn variant="primary" onClick={onEnter}>
            Go to App <Icon name="chevRight" size={14} stroke="var(--char-950)" />
          </Btn>
        </div>
        {/* hero anchor = the origin soma sits just below the copy */}
        <div ref={(el) => { anchorRefs.current[0] = el; }} style={{ height: 150, width: 1, marginTop: 12 }} />
        <span style={{ fontSize: 12, color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="chevDown" size={13} stroke="var(--fg-3)" /> scroll — follow the signal
        </span>
      </section>

      {/* ── Synapse sections: each feature fires as the pulse passes ── */}
      {SECTIONS.map((s, i) => (
        <section
          key={s.eyebrow}
          ref={(el) => { sectionRefs.current[i] = el; }}
          data-idx={i}
          style={{
            minHeight: '78vh', display: 'flex', alignItems: 'center',
            position: 'relative', zIndex: 1, padding: '40px 22px',
          }}
        >
          <div style={{ maxWidth: 1080, width: '100%', margin: '0 auto', display: 'flex', justifyContent: i % 2 === 1 ? 'flex-end' : 'flex-start' }}>
            {/* synapse anchor on the opposite side of the card */}
            <div ref={(el) => { anchorRefs.current[i + 1] = el; }}
              style={{ position: 'absolute', top: '50%', width: 1, height: 1 }} />
            <div style={{
              ...card,
              opacity: seen[i] ? 1 : 0,
              transform: seen[i] ? 'none' : 'translateY(26px)',
              transition: 'opacity 600ms ease, transform 600ms ease',
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--burn)', fontSize: 11.5, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600 }}>
                <Icon name={s.icon} size={14} stroke="var(--burn)" /> {s.eyebrow}
              </span>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 3.2vw, 32px)', margin: '10px 0 10px', lineHeight: 1.15 }}>
                {s.title}
              </h2>
              <p style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--fg-2)', margin: 0 }}>{s.body}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
                {s.chips.map((c) => (
                  <span key={c} className="mono" style={{
                    fontSize: 11, padding: '4px 10px', borderRadius: 20,
                    border: '1px solid var(--border)', color: 'var(--fg-3)',
                  }}>{c}</span>
                ))}
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* ── Finale: the message arrives at the second neuron ── */}
      <section style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        position: 'relative', zIndex: 1, padding: '60px 20px', gap: 18,
      }}>
        <div ref={(el) => { anchorRefs.current[SECTIONS.length + 1] = el; }}
          style={{ height: 150, width: 1, marginBottom: 10 }} />
        <h2 style={{
          fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4.5vw, 48px)',
          margin: 0, lineHeight: 1.1, maxWidth: 640, textWrap: 'balance',
          opacity: arrived ? 1 : 0.35, transition: 'opacity 600ms ease',
        }}>
          The signal arrived.<br />
          <span style={{ color: 'var(--burn)' }}>Now send yours.</span>
        </h2>
        <p style={{ fontSize: 14, color: 'var(--fg-2)', maxWidth: 480, margin: 0, lineHeight: 1.6 }}>
          Sign in with Internet Identity. Burn, stake, play, pitch — every payout finds your
          wallet on its own.
        </p>
        <Btn variant="primary" onClick={onEnter}>
          Go to App <Icon name="chevRight" size={14} stroke="var(--char-950)" />
        </Btn>

        {/* ── Community — ICP Dapp Factory ── */}
        <div className="col" style={{
          gap: 14, alignItems: 'center', marginTop: 40, padding: '24px 22px',
          border: '1px solid var(--border)', borderRadius: 14,
          background: 'color-mix(in srgb, var(--char-950) 70%, transparent)',
          backdropFilter: 'blur(6px)', maxWidth: 460, width: '100%',
        }}>
          <img
            src="/dapp-factory.png" alt="ICP Dapp Factory"
            style={{ width: 200, maxWidth: '70%', borderRadius: 10, border: '1px solid var(--border)' }}
          />
          <div className="col" style={{ gap: 4, alignItems: 'center' }}>
            <b style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>Built by the ICP Dapp Factory</b>
            <span style={{ fontSize: 13, color: 'var(--fg-2)', textAlign: 'center', lineHeight: 1.5 }}>
              Join the community shipping dapps on the Internet Computer — ask questions, follow
              what's next, and help steer this one.
            </span>
          </div>
          <a
            href={DISCORD_INVITE} target="_blank" rel="noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 9, textDecoration: 'none',
              background: '#5865F2', color: '#fff', fontWeight: 600, fontSize: 13.5,
              padding: '10px 18px', borderRadius: 30,
            }}
          >
            <DiscordMark size={18} color="#fff" /> Join the Discord
          </a>
        </div>

        <span style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 18 }}>
          Cycles of Influence · an ICP Dapp Factory build · runs entirely on the Internet Computer
        </span>
      </section>
    </div>
  );
}
