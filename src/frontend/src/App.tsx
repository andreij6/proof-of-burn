import React, { useState, useEffect } from 'react';
import { AuthClient } from "@icp-sdk/auth/client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import { createActor as createBackendActor } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type { Proposal } from "./bindings/backend";

// ==========================================
// 1. Icon Component (Clean, inline SVG paths)
// ==========================================

const iconPaths: Record<string, React.ReactNode> = {
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
  refresh: <><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 4v4h-4" /></>
};

interface IconProps {
  name: string;
  size?: number;
  stroke?: string;
  sw?: number;
  style?: React.CSSProperties;
}

function Icon({ name, size = 16, stroke = 'currentColor', sw = 1.5, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block', ...style }}>
      {iconPaths[name]}
    </svg>
  );
}

// ==========================================
// 2. Base Helpers and UI components
// ==========================================

function Eyebrow({ children, accent, style }: { children: React.ReactNode; accent?: boolean; style?: React.CSSProperties }) {
  return (
    <span className="mono" style={{
      fontSize: 10.5, fontWeight: 500, letterSpacing: '0.09em', textTransform: 'uppercase',
      color: accent ? 'var(--burn)' : 'var(--fg-3)', ...style
    }}>
      {children}
    </span>
  );
}

const CHIP_TONES = {
  muted:   { bg: 'transparent',        bd: 'var(--border)',  fg: 'var(--fg-2)' },
  burn:    { bg: 'var(--burn-950)',    bd: 'var(--burn)',    fg: 'var(--burn)' },
  solid:   { bg: 'var(--burn)',        bd: 'var(--burn)',    fg: 'var(--char-950)' },
  ok:      { bg: 'var(--sprout-dim)',  bd: 'var(--sprout)',  fg: 'var(--sprout)' },
  danger:  { bg: 'var(--ember-dim)',   bd: 'var(--ember)',   fg: 'var(--ember)' },
  pending: { bg: 'var(--haze-dim)',    bd: 'var(--haze)',    fg: 'var(--haze)' },
  dashed:  { bg: 'transparent',        bd: 'var(--border-hi)', fg: 'var(--fg-3)' },
};

function Chip({ tone = 'muted', children, style }: { tone?: keyof typeof CHIP_TONES; children: React.ReactNode; style?: React.CSSProperties }) {
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

function Btn({ variant = 'secondary', sm, children, disabled, style, onClick }: {
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

function HeatBar({ pct = 0, committed, req, met }: { pct?: number; committed?: string; req?: string; met?: boolean }) {
  return (
    <div className="col" style={{ gap: 7 }}>
      <div style={{ height: 8, borderRadius: 999, background: 'var(--char-800)', overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 999,
          background: met ? 'var(--sprout)' : 'var(--burn)',
          transition: 'width 1s var(--ease-out)'
        }} />
      </div>
      {(committed || req) && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>{committed}</span>
          <span className="mono" style={{ fontSize: 12, color: met ? 'var(--sprout)' : 'var(--burn)', fontWeight: 500, whiteSpace: 'nowrap' }}>{req}</span>
        </div>
      )}
    </div>
  );
}

function LiveDot({ color = 'var(--burn)', size = 6, on = true, style }: { color?: string; size?: number; on?: boolean; style?: React.CSSProperties }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: 999, background: color,
      flexShrink: 0, animation: on ? 'il-pulse 2s var(--ease-in-out) infinite' : 'none', ...style
    }} />
  );
}

// ── Gate (renders real content, then blurs + locks per state) ─
function Gate({ children, hint, next, height, gating }: { children: React.ReactNode; hint: string; next?: boolean; height?: number; gating: string }) {
  const lockTone = next ? 'burn' : 'muted';
  const overlay = (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
      <Chip tone={lockTone} style={{ height: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
        <Icon name={next ? 'spark' : 'lock'} size={12} /> {hint}
      </Chip>
    </div>
  );

  if (gating === 'skeleton') {
    return (
      <div style={{ position: 'relative', minHeight: height }}>
        {overlay}
        <div style={{ filter: 'grayscale(1)', opacity: 0.18, pointerEvents: 'none', userSelect: 'none' }}>{children}</div>
      </div>
    );
  }
  if (gating === 'faded') {
    return (
      <div style={{ position: 'relative', minHeight: height }}>
        {overlay}
        <div style={{ opacity: 0.28, pointerEvents: 'none', userSelect: 'none' }}>{children}</div>
      </div>
    );
  }
  // default: blur
  return (
    <div style={{ position: 'relative', minHeight: height }}>
      {overlay}
      <div style={{ filter: 'blur(5px) saturate(0.6)', opacity: 0.5, pointerEvents: 'none', userSelect: 'none' }}>{children}</div>
    </div>
  );
}

function Reveal({ delay = 0, children, style, motion }: { delay?: number; children: React.ReactNode; style?: React.CSSProperties; motion: string }) {
  const [shown, setShown] = useState(motion === 'off');
  useEffect(() => {
    if (motion === 'off') { setShown(true); return; }
    const id = setTimeout(() => setShown(true), 70 + delay);
    return () => clearTimeout(id);
  }, [motion, delay]);
  const dur = motion === 'subtle' ? 260 : 440;
  return (
    <div style={{
      opacity: shown ? 1 : 0,
      transform: shown ? 'none' : 'translateY(10px)',
      filter: shown ? 'none' : (motion === 'expressive' ? 'blur(4px)' : 'none'),
      transition: `opacity ${dur}ms var(--ease-out), transform ${dur}ms var(--ease-out), filter ${dur}ms var(--ease-out)`,
      ...style
    }}>
      {children}
    </div>
  );
}

// Formatting helpers
function fmtICP(n: number | bigint) {
  return (Number(n) / 100_000_000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatPrincipal(p: Principal | null): string {
  if (!p) return "anon";
  const s = p.toString();
  if (s === "2vxsx-fae") return "Anonymous";
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}

// TIER META definition
const TIER_META = [
  ['Tier 0', 'Anonymous visitor', 'Minimum to understand + start', 'lands on the page'],
  ['Tier 1', 'Authenticated', 'Signed in via Internet Identity', 'signs in'],
  ['Tier 2', 'Verified follower', 'On-chain follow confirmed', 'follows the neuron'],
  ['Tier 3', 'Active participant', 'Has committed to burn', 'commits on ≥1 proposal'],
];

// AIPanel Component
function AIPanel({ open, onToggle, score, text }: { open: boolean; onToggle: () => void; score: string; text: string }) {
  return (
    <div style={{ border: '1px solid var(--burn)', borderRadius: 8, background: 'var(--burn-950)', overflow: 'hidden' }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, padding: '9px 12px', background: 'transparent', border: 'none', cursor: 'pointer'
      }}>
        <span className="row" style={{ gap: 7, color: 'var(--burn)', fontSize: 13 }}>
          <Icon name="spark" size={14} stroke="var(--burn)" /> AI review
        </span>
        <span className="row" style={{ gap: 9 }}>
          <Chip tone="burn" style={{ height: 20, fontSize: 11 }}>Impact {score}</Chip>
          <Icon name={open ? 'chevDown' : 'chevRight'} size={15} stroke="var(--fg-3)" />
        </span>
      </button>
      {open && (
        <div className="col" style={{ gap: 9, padding: '0 12px 12px' }}>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-1)', margin: 0 }}>
            {text}
          </p>
          <div className="row" style={{
            justifyContent: 'space-between', alignItems: 'center', paddingTop: 8,
            borderTop: '1px solid color-mix(in srgb, var(--burn) 25%, transparent)'
          }}>
            <span className="row" style={{
              gap: 6, fontSize: 11.5, color: 'var(--fg-2)', cursor: 'pointer',
              textDecoration: 'underline dotted', textUnderlineOffset: 3
            }}>
              <Icon name="info" size={12} stroke="var(--fg-3)" /> System prompt + tools used
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>paid · 0.05 ICP</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// 3. Main React App
// ==========================================

export default function App() {
  // Canister environment resolution
  const env = safeGetCanisterEnv<{
    'PUBLIC_CANISTER_ID:backend': string;
    'PUBLIC_CANISTER_ID:ledger': string;
  }>();

  const host = window.location.origin;
  const backendCanisterId = env?.['PUBLIC_CANISTER_ID:backend'] || "a5dhi-k7777-77775-aaabq-cai";
  const ledgerCanisterId = env?.['PUBLIC_CANISTER_ID:ledger'] || "aiewf-lx777-77775-aaaca-cai";

  // Auth & Identity state
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [identity, setIdentity] = useState<any>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [actor, setActor] = useState<any>(null);

  // Derived / Application state
  const [isFollowing, setIsFollowing] = useState(false);
  const [holdings, setHoldings] = useState<bigint>(0n);
  const [commitments, setCommitments] = useState<Record<string, bigint>>({});
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Tweak / simulator options
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [gating, setGating] = useState<string>('blur');
  const [aiMode, setAiMode] = useState<string>('collapsed');
  const [motion, setMotion] = useState<string>('expressive');

  // Input states for each proposal
  const [burnInputs, setBurnInputs] = useState<Record<string, string>>({});
  const [aiOpenMap, setAiOpenMap] = useState<Record<string, boolean>>({});

  // Neuron copy status
  const [copied, setCopied] = useState(false);

  // Deriving the tier dynamically
  const tier = !principal || principal.isAnonymous()
    ? 0
    : !isFollowing
    ? 1
    : Object.keys(commitments).length > 0
    ? 3
    : 2;

  // Initialize Auth
  useEffect(() => {
    AuthClient.create().then(async (client) => {
      setAuthClient(client);
      const authenticated = await client.isAuthenticated();
      if (authenticated) {
        const id = client.getIdentity();
        const pri = id.getPrincipal();
        setPrincipal(pri);
        setIdentity(id);
        const newActor = createBackendActor(backendCanisterId, {
          agentOptions: { host, identity: id, rootKey: env?.IC_ROOT_KEY }
        });
        setActor(newActor);
      } else {
        setPrincipal(Principal.anonymous());
        setActor(createBackendActor(backendCanisterId, {
          agentOptions: { host, rootKey: env?.IC_ROOT_KEY }
        }));
      }
    });
  }, []);

  // Fetch Proposals from Backend Canister
  useEffect(() => {
    if (!actor) return;
    setIsLoading(true);
    actor.list_active_proposals()
      .then((list: Proposal[]) => {
        setProposals(list);
      })
      .catch((err: any) => {
        console.error("Failed to load active proposals:", err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [actor]);

  // Fetch Ledger Balance
  useEffect(() => {
    if (!principal || principal.isAnonymous() || !identity) {
      setHoldings(0n);
      return;
    }
    const ledgerActor = createLedgerActor(ledgerCanisterId, {
      agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
    });
    ledgerActor.icrc1_balance_of({ owner: principal })
      .then((bal: bigint) => {
        setHoldings(bal);
      })
      .catch((err: any) => {
        console.warn("Failed to fetch balance, using simulated balance:", err);
        // Local Pocket-IC developer mode fallback balance
        setHoldings(1000_00000000n);
      });
  }, [principal, identity]);

  // Handle Internet Identity login
  const handleLogin = async () => {
    if (!authClient) return;
    await authClient.login({
      identityProvider: "http://id.ai.localhost:8000",
      maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000), // 8h
      onSuccess: async () => {
        const id = authClient.getIdentity();
        const pri = id.getPrincipal();
        setPrincipal(pri);
        setIdentity(id);
        const newActor = createBackendActor(backendCanisterId, {
          agentOptions: { host, identity: id, rootKey: env?.IC_ROOT_KEY }
        });
        setActor(newActor);
      }
    });
  };

  // Handle logout
  const handleLogout = async () => {
    if (!authClient) return;
    await authClient.logout();
    setPrincipal(Principal.anonymous());
    setIdentity(null);
    setActor(createBackendActor(backendCanisterId, {
      agentOptions: { host, rootKey: env?.IC_ROOT_KEY }
    }));
    setIsFollowing(false);
    setHoldings(0n);
    setCommitments({});
  };

  // Handle Neuron Copy
  const handleCopy = () => {
    navigator.clipboard.writeText("4821667");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle Commit to Burn
  const handleCommit = (proposalId: bigint, amountStr: string) => {
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      alert("Please enter a valid amount.");
      return;
    }
    const amountE8s = BigInt(Math.floor(amount * 100_000_000));
    if (amountE8s > holdings) {
      alert("Commitment exceeds your verified ICP holdings!");
      return;
    }

    setCommitments(prev => ({
      ...prev,
      [proposalId.toString()]: (prev[proposalId.toString()] || 0n) + amountE8s
    }));

    setProposals(prev => prev.map(p => {
      if (p.id === proposalId) {
        const updatedCommitted = p.total_committed_e8s + amountE8s;
        return {
          ...p,
          total_committed_e8s: updatedCommitted,
          status: updatedCommitted >= p.threshold_e8s ? "met" : p.status
        };
      }
      return p;
    }));

    setBurnInputs(prev => ({
      ...prev,
      [proposalId.toString()]: ""
    }));
  };

  // AI reviews Mock map
  const aiReviews: Record<string, { score: string; text: string }> = {
    "138402": {
      score: "7.4",
      text: "Cuts emission ~12% with negligible decentralization risk. Node-provider churn is the main downside — three small operators fall below break-even at current cycle prices."
    },
    "138388": {
      score: "8.1",
      text: "Establishes sound long-term SNS-3 allocations. Reduces NNS voting rewards inflation pressure while keeping developers funded."
    },
    "138376": {
      score: "6.2",
      text: "Adds useful redundancy for European subnets. Hardware checks passed, but the hosting cost is slightly above index average."
    }
  };

  // Apply light theme data attribute to documentElement
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  // Aggregate user stats for Tier 3
  const totalCommitted = Object.values(commitments).reduce((a, b) => a + b, 0n);
  const totalBurned = 0n; // In Milestone 1, they are not finalized on-chain yet
  const proposalsJoined = Object.keys(commitments).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* ── App Header ── */}
      <header style={{
        height: 'var(--nav-h)', borderBottom: '1px solid var(--border)', background: 'var(--bg-alt)',
        padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 10
      }}>
        <div className="row" style={{ gap: 10 }}>
          <span style={{
            width: 32, height: 32, display: 'grid', placeItems: 'center',
            border: '1px solid var(--burn)', borderRadius: 8, background: 'var(--burn-950)'
          }}>
            <Icon name="flame" size={17} stroke="var(--burn)" />
          </span>
          <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: '-0.02em', color: 'var(--fg)' }}>
            Proof of Burn DAO
          </b>
        </div>

        <div className="row" style={{ gap: 16 }}>
          <Btn variant="ghost" sm onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
            <Icon name="spark" size={14} /> Theme: {theme.toUpperCase()}
          </Btn>

          {!principal || principal.isAnonymous() ? (
            <Btn variant="primary" sm onClick={handleLogin}>
              <Icon name="key" size={14} stroke="var(--char-950)" /> Sign in
            </Btn>
          ) : (
            <span className="row" style={{
              gap: 8, height: 30, padding: '0 10px', borderRadius: 6,
              border: '1px solid var(--border-hi)', background: 'var(--surface)'
            }}>
              <Icon name="wallet" size={14} stroke="var(--fg-2)" />
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)' }}>
                {formatPrincipal(principal)}
              </span>
              <span style={{ fontSize: 12, color: 'var(--fg-3)', marginLeft: 4 }}>
                ({fmtICP(holdings)} ICP)
              </span>
              <LiveDot color="var(--sprout)" size={6} />
              <button onClick={handleLogout} title="Sign out" style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--ember)', padding: '0 2px', marginLeft: 4, display: 'flex', alignItems: 'center'
              }}>
                <Icon name="x" size={13} stroke="var(--ember)" />
              </button>
            </span>
          )}
        </div>
      </header>

      {/* ── Main Layout (Dashboard + Sidebar Tweak Panel) ── */}
      <div style={{ display: 'flex', flex: 1, flexWrap: 'wrap-reverse' }}>
        
        {/* Left Column: Dashboard content */}
        <main style={{ flex: 1, minWidth: 320 }}>
          <div className="dashboard-container">
            
            {/* Tier 3 Dashboard Strip */}
            {tier >= 3 && (
              <Reveal delay={40} motion={motion}>
                <div className="row" style={{
                  border: '1px solid var(--burn)', borderRadius: 10, background: 'var(--burn-950)',
                  padding: '14px 6px'
                }}>
                  <div className="col" style={{ gap: 4, flex: 1, alignItems: 'center', textAlign: 'center' }}>
                    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <Icon name="coins" size={15} stroke="var(--burn)" />
                      <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                        {fmtICP(totalCommitted)} ICP
                      </span>
                    </span>
                    <Eyrow>Committed</Eyrow>
                  </div>
                  <div className="col" style={{
                    gap: 4, flex: 1, alignItems: 'center', textAlign: 'center',
                    borderLeft: '1px solid color-mix(in srgb, var(--burn) 28%, transparent)'
                  }}>
                    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <Icon name="flame" size={15} stroke="var(--burn)" />
                      <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                        {fmtICP(totalBurned)} ICP
                      </span>
                    </span>
                    <Eyrow>Burned to date</Eyrow>
                  </div>
                  <div className="col" style={{
                    gap: 4, flex: 1, alignItems: 'center', textAlign: 'center',
                    borderLeft: '1px solid color-mix(in srgb, var(--burn) 28%, transparent)'
                  }}>
                    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <Icon name="checkCircle" size={15} stroke="var(--burn)" />
                      <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                        {proposalsJoined}
                      </span>
                    </span>
                    <Eyrow>Proposals joined</Eyrow>
                  </div>
                </div>
              </Reveal>
            )}

            {/* ── PB-071: Neuron Identity Block ── */}
            <Reveal delay={70} motion={motion}>
              <div className="card col" style={{ gap: 13 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div className="col" style={{ gap: 7, minWidth: 0 }}>
                    <Eyrow>Follow this neuron</Eyrow>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="mono" style={{ fontSize: 18, color: 'var(--fg)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                        Neuron 4.821.667
                      </span>
                      <button onClick={handleCopy} title="Copy neuron ID" style={{
                        display: 'grid', placeItems: 'center', width: 24, height: 24,
                        borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer'
                      }}>
                        <Icon name={copied ? "check" : "copy"} size={12} stroke={copied ? "var(--sprout)" : "var(--fg-3)"} />
                      </button>
                    </div>
                  </div>
                  {isFollowing ? (
                    <Chip tone="ok" style={{ height: 24 }}><Icon name="check" size={12} /> Following</Chip>
                  ) : (
                    <Chip tone="muted" style={{ height: 24 }}><LiveDot color="var(--fg-3)" on={false} /> Not following</Chip>
                  )}
                </div>

                <div className="col" style={{ gap: 6 }}>
                  <div style={{ height: 6, borderRadius: 999, background: 'var(--char-800)', overflow: 'hidden' }}>
                    <div style={{ width: '72%', height: '100%', background: 'var(--border-hi)', borderRadius: 999 }} />
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
                      VP 4,821,667 · 1,204 votes
                    </span>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      8y dissolve
                    </span>
                  </div>
                </div>

                <div className="row" style={{
                  justifyContent: 'space-between', alignItems: 'center', paddingTop: 10,
                  borderTop: '1px solid var(--border)', marginTop: 1
                }}>
                  <a href="https://nns.ic0.app" target="_blank" rel="noreferrer" style={{ textDecoration: 'none', flexShrink: 0 }}>
                    <span className="row" style={{ gap: 6, color: 'var(--fg-2)', fontSize: 13, whiteSpace: 'nowrap' }}>
                      <Icon name="external" size={13} /> Open in NNS
                    </span>
                  </a>

                  {!isFollowing ? (
                    !principal || principal.isAnonymous() ? (
                      <span className="row" style={{ gap: 6, color: 'var(--burn)', fontSize: 12.5, whiteSpace: 'nowrap' }}>
                        <Icon name="arrowUp" size={13} stroke="var(--burn)" /> Sign in to follow
                      </span>
                    ) : (
                      <Btn variant="primary" sm onClick={() => setIsFollowing(true)}>
                        <Icon name="check" size={13} stroke="var(--char-950)" /> Follow neuron
                      </Btn>
                    )
                  ) : (
                    <span className="row" style={{ gap: 6, color: 'var(--sprout)', fontSize: 12.5 }}>
                      <Icon name="checkCircle" size={13} stroke="var(--sprout)" /> Verified on-chain
                    </span>
                  )}
                </div>
              </div>
            </Reveal>

            {/* proposals List title row */}
            <Reveal delay={100} motion={motion}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <span className="row" style={{ gap: 8, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  <Icon name="list" size={15} stroke="var(--fg-2)" />
                  <b style={{ fontSize: 14, color: 'var(--fg)' }}>Active proposals</b>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {proposals.length}</span>
                </span>
                <Eyebrow style={{ whiteSpace: 'nowrap' }}>title · category · deadline</Eyebrow>
              </div>
            </Reveal>

            {/* proposals list */}
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-3)' }}>
                <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
                Fetching active NNS proposals...
              </div>
            ) : (
              <div className="col" style={{ gap: 12 }}>
                {proposals.map((p, i) => {
                  const showBurn = tier >= 1;
                  const canCommit = tier >= 2;
                  const proposalIdStr = p.id.toString();
                  const aiReview = aiReviews[proposalIdStr];
                  const aiOpen = aiOpenMap[proposalIdStr] || (aiMode === 'expanded' && i === 0);

                  const pct = Math.min(100, Math.floor((Number(p.total_committed_e8s) / Number(p.threshold_e8s)) * 100));
                  const met = p.status === 'met' || p.total_committed_e8s >= p.threshold_e8s;

                  const committedLabel = `${fmtICP(p.total_committed_e8s)} ICP committed`;
                  const reqLabel = met ? `${pct}% · met` : `${pct}% of ${fmtICP(p.threshold_e8s)} ICP`;

                  const statusChip = met ? (
                    <Chip tone="ok"><Icon name="check" size={11} /> Threshold met</Chip>
                  ) : (
                    <Chip tone="muted"><LiveDot on={motion !== 'off'} /> Open</Chip>
                  );

                  // Calculate deadline string
                  const remainingNs = Number(p.deadline) - Date.now() * 1_000_000;
                  const remainingH = Math.max(0, Math.floor(remainingNs / (3600 * 1_000_000_000)));
                  const remainingD = Math.floor(remainingH / 24);
                  const deadlineStr = remainingD > 0
                    ? `${remainingD}d ${remainingH % 24}h`
                    : `${remainingH}h`;

                  const committedAmount = commitments[proposalIdStr];
                  const mineBadge = committedAmount && (
                    <Chip tone={met ? "burn" : "dashed"}>
                      {met ? <Icon name="flame" size={11} stroke="var(--burn)" /> : null}
                      You · {fmtICP(committedAmount)} ICP {met ? "burning soon" : "pending"}
                    </Chip>
                  );

                  return (
                    <Reveal key={proposalIdStr} delay={120 + i * 70} motion={motion}>
                      <div className="col" style={{
                        gap: 12, border: `1px solid ${met ? 'var(--sprout)' : 'var(--border)'}`,
                        borderRadius: 8, background: 'var(--surface)', padding: 14
                      }}>
                        {/* Title and stats header */}
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                          <div className="col" style={{ gap: 7, minWidth: 0, flex: 1 }}>
                            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <Chip tone="muted" style={{ height: 20, fontSize: 11 }}>{p.category}</Chip>
                              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
                                #{proposalIdStr}
                              </span>
                            </div>
                            <span style={{ fontSize: 14, lineHeight: 1.35, color: 'var(--fg)', fontWeight: 500, textWrap: 'pretty' }}>
                              {p.title}
                            </span>
                          </div>
                          <div className="col" style={{ alignItems: 'flex-end', gap: 7, flexShrink: 0 }}>
                            <Chip tone="muted" style={{ height: 22 }}>
                              <Icon name="clock" size={11} /> {deadlineStr}
                            </Chip>
                            {tier >= 1 && statusChip}
                          </div>
                        </div>

                        {/* Burn progress (gated for anonymous) */}
                        {showBurn ? (
                          <HeatBar pct={pct} committed={committedLabel} req={reqLabel} met={met} />
                        ) : (
                          <Gate hint="Sign in to unlock" height={44} gating={gating}>
                            <HeatBar pct={48} committed="●●● ICP committed" req="●● of ●●● ICP" />
                          </Gate>
                        )}

                        {/* Action zone */}
                        {tier >= 1 && <div style={{ borderTop: '1px solid var(--border)' }} />}

                        {tier === 1 && (
                          <Gate hint="Follow neuron to unlock" next height={42} gating={gating}>
                            <div className="row" style={{ gap: 8 }}>
                              <input type="text" disabled placeholder="Amount to burn" className="burn-input" />
                              <Btn variant="primary" sm>Commit</Btn>
                              <Btn variant="ghost" sm><Icon name="spark" size={13} /> AI</Btn>
                            </div>
                          </Gate>
                        )}

                        {canCommit && (
                          <div className="col" style={{ gap: 10 }}>
                            <div className="row" style={{ gap: 8 }}>
                              <div style={{ flex: 1, position: 'relative' }}>
                                <input
                                  type="number"
                                  placeholder="Amount to burn"
                                  className="burn-input"
                                  value={burnInputs[proposalIdStr] || ""}
                                  onChange={(e) => setBurnInputs({ ...burnInputs, [proposalIdStr]: e.target.value })}
                                />
                                <span className="mono" style={{
                                  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                                  fontSize: 13, color: 'var(--fg-3)'
                                }}>
                                  ICP
                                </span>
                              </div>
                              <Btn
                                variant="primary"
                                sm
                                onClick={() => handleCommit(p.id, burnInputs[proposalIdStr] || "")}
                              >
                                <Icon name="flame" size={13} stroke="var(--char-950)" /> Commit
                              </Btn>
                            </div>

                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                              <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                <Icon name="coins" size={12} stroke="var(--fg-3)" /> Holdings: <span className="mono" style={{ color: 'var(--fg)' }}>{fmtICP(holdings)} ICP</span>
                                <span style={{ color: 'var(--fg-3)' }}>· cap enforced</span>
                              </span>
                              {mineBadge}
                            </div>

                            {/* AI Review Panel */}
                            {aiReview && aiMode !== 'hidden' && (
                              <AIPanel
                                open={aiOpen}
                                onToggle={() => setAiOpenMap({ ...aiOpenMap, [proposalIdStr]: !aiOpen })}
                                score={aiReview.score}
                                text={aiReview.text}
                              />
                            )}

                            {/* No-burn safety note */}
                            <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                              <Icon name="info" size={12} stroke="var(--fg-3)" /> No burn if threshold misses — committed ICP is returned.
                            </span>
                          </div>
                        )}
                      </div>
                    </Reveal>
                  );
                })}
              </div>
            )}

            {/* ── Vote History ── */}
            <Reveal delay={300} motion={motion}>
              <div className="col" style={{ gap: 11, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Icon name="list" size={15} stroke="var(--fg-2)" />
                    <b style={{ fontSize: 14, color: 'var(--fg)' }}>Vote history</b>
                  </span>
                  <Eyebrow>neuron votes · outcome · burned</Eyebrow>
                </div>

                {tier >= 1 ? (
                  <div className="col" style={{ gap: 0 }}>
                    {[
                      ['Increase replica memory ceiling to 8 GiB', 'yes', '12.4'],
                      ['Deprecate legacy ledger archive canister', 'against', '6.0'],
                      ['Fund developer-grant round 7 (40k ICP)', 'yes', '20.1'],
                    ].map(([t, v, burned], i) => (
                      <div key={i} className="row" style={{
                        justifyContent: 'space-between', gap: 12, padding: '10px 0',
                        borderBottom: i < 2 ? '1px solid var(--border)' : 'none'
                      }}>
                        <span style={{
                          fontSize: 12.5, color: 'var(--fg-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {t}
                        </span>
                        <div className="row" style={{ gap: 9, flexShrink: 0 }}>
                          <Chip tone={v === 'against' ? 'muted' : 'ok'} style={{ height: 20, fontSize: 11 }}>{v}</Chip>
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--burn)', width: 78, textAlign: 'right' }}>
                            {burned} burned
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Gate hint="Sign in to unlock" height={120} gating={gating}>
                    <div className="col" style={{ gap: 12 }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontSize: 12 }}>Unlockable History</span></div>
                    </div>
                  </Gate>
                )}
              </div>
            </Reveal>
          </div>
        </main>

        {/* Right Column: Tweak panel & Progression Ladder */}
        <aside style={{
          width: 320, padding: 24, borderLeft: '1px solid var(--border)', background: 'var(--bg-alt)',
          display: 'flex', flexDirection: 'column', gap: 24, flexShrink: 0
        }}>
          {/* Tweak Panel Header */}
          <div className="col" style={{ gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--burn)', letterSpacing: '0.1em' }}>
              Simulator & Tweaks
            </span>
            <h4 style={{ margin: 0, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>Dashboard Controls</h4>
          </div>

          {/* Gating Mode selector */}
          <div className="col" style={{ gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Gating visual style</span>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {['blur', 'skeleton', 'faded'].map(g => (
                <Btn key={g} variant={gating === g ? 'primary' : 'secondary'} sm onClick={() => setGating(g)}>
                  {g.toUpperCase()}
                </Btn>
              ))}
            </div>
          </div>

          {/* AI Panel Mode selector */}
          <div className="col" style={{ gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>AI review panel</span>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {['collapsed', 'expanded', 'hidden'].map(a => (
                <Btn key={a} variant={aiMode === a ? 'primary' : 'secondary'} sm onClick={() => setAiMode(a)}>
                  {a.toUpperCase()}
                </Btn>
              ))}
            </div>
          </div>

          {/* Motion intensity selector */}
          <div className="col" style={{ gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Motion / Transition</span>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {['expressive', 'subtle', 'off'].map(m => (
                <Btn key={m} variant={motion === m ? 'primary' : 'secondary'} sm onClick={() => setMotion(m)}>
                  {m.toUpperCase()}
                </Btn>
              ))}
            </div>
          </div>

          <hr />

          {/* Progression Ladder */}
          <div className="col" style={{ gap: 12 }}>
            <Eyebrow>The Four Tiers</Eyebrow>
            <div className="col" style={{ gap: 10 }}>
              {TIER_META.map(([tag, name, desc, _trig], idx) => {
                const isActive = tier >= idx;
                const isNext = tier + 1 === idx;
                return (
                  <div key={idx} style={{
                    padding: 10, borderRadius: 6, border: `1px solid ${isActive ? 'var(--burn)' : isNext ? 'var(--border-hi)' : 'var(--border)'}`,
                    background: isActive ? 'var(--burn-950)' : 'transparent',
                    opacity: isActive ? 1 : 0.6,
                    transition: 'all 0.3s var(--ease-out)'
                  }}>
                    <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                      <span className="mono" style={{ fontSize: 11, color: isActive ? 'var(--burn)' : 'var(--fg-3)' }}>{tag}</span>
                      {isActive && <Icon name="checkCircle" size={14} stroke="var(--sprout)" />}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginTop: 2 }}>{name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>{desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Local test accounts helper */}
          {principal && !principal.isAnonymous() && (
            <div className="simulator-panel col">
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>Local Funding Tool</span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>Add 500 ICP mock balance to test holding limits.</span>
              <Btn variant="secondary" sm onClick={() => setHoldings(prev => prev + 500_00000000n)}>
                <Icon name="zap" size={12} stroke="var(--burn)" /> Add 500 ICP
              </Btn>
            </div>
          )}
        </aside>

      </div>
    </div>
  );
}

// Simple type definitions helper
function Eyrow({ children }: { children: React.ReactNode }) {
  return <Eyebrow style={{ marginTop: 2 }}>{children}</Eyebrow>;
}
