import React, { useState, useEffect } from 'react';
import { AuthClient } from "@icp-sdk/auth/client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import { createActor as createBackendActor, Vote, Stance, CommitmentStatus } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type { Proposal, EligibilityInfo, VoteRecord, Commitment, GlobalStats, Config, LeaderNeuronInfo } from "./bindings/backend";

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
  const barPct = Math.min(100, pct); // visual bar caps at 100%
  const isOversubscribed = pct >= 100;

  if (isOversubscribed) {
    return (
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>
          {committed}
        </span>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 7 }}>
      <div style={{ height: 8, borderRadius: 999, background: 'var(--char-800)', overflow: 'hidden' }}>
        <div style={{
          width: `${barPct}%`, height: '100%', borderRadius: 999,
          background: met ? 'var(--sprout)' : 'var(--burn)',
          transition: 'width 1s var(--ease-out)',
          boxShadow: 'none',
        }} />
      </div>
      {(committed || req) && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>{committed}</span>
          <span className="mono" style={{ fontSize: 12, color: met ? 'var(--sprout)' : 'var(--burn)', fontWeight: 500, whiteSpace: 'nowrap' }}>
            {req}
          </span>
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

// Neuron IDs are u64 and exceed Number.MAX_SAFE_INTEGER — keep them BigInt.
// Displayed as plain decimal digits with no separators — the NNS itself
// shows neuron ids without commas, and a comma at "4,821,667" reads like
// a formatted money amount rather than an opaque identifier.
function formatNeuronId(id: bigint | null | undefined): string {
  if (id === null || id === undefined) return "…";
  return id.toString();
}

// NNS voting power is reported in e8s units (1 VP = 1e8). Show whole VP, grouped.
function fmtVP(vp: bigint): string {
  const whole = vp / 100_000_000n;
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
  const identityProviderUrl = isLocal
    ? "http://id.ai.localhost:8000"
    : "https://identity.ic0.app";

  // Auth & Identity state
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [identity, setIdentity] = useState<any>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [actor, setActor] = useState<any>(null);

  // Derived / Application state
  const [isFollowing, setIsFollowing] = useState(false);
  const [neuronIdInput, setNeuronIdInput] = useState("");
  const [hotkeyCopied, setHotkeyCopied] = useState(false);
  const [eligibility, setEligibility] = useState<EligibilityInfo | null>(null);
  const [voteHistory, setVoteHistory] = useState<VoteRecord[]>([]);
  const [holdings, setHoldings] = useState<bigint>(0n);
  const [myCommitments, setMyCommitments] = useState<Commitment[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [leaderInfo, setLeaderInfo] = useState<LeaderNeuronInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  // Transaction / Modal state
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransacting, setIsTransacting] = useState(false);
  const [txStep, setTxStep] = useState<string>("");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState(false);
  const [confirmProposalId, setConfirmProposalId] = useState<bigint | null>(null);
  const [confirmAmount, setConfirmAmount] = useState<string>("");
  const [confirmStance, setConfirmStance] = useState<Stance | null>(null);

  // System health state
  const [cycleBalance, setCycleBalance] = useState<bigint | null>(null);
  const [treasuryBalance, setTreasuryBalance] = useState<bigint | null>(null);

  // Tweak / simulator options
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [gating, setGating] = useState<string>('blur');
  const [aiMode, setAiMode] = useState<string>('hidden');
  const [motion, setMotion] = useState<string>('expressive');

  // Input states for each proposal
  const [aiOpenMap, setAiOpenMap] = useState<Record<string, boolean>>({});

  // Neuron copy status
  const [copied, setCopied] = useState(false);

  // Eligibility & Vote History Helpers
  const refreshEligibility = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const info = await currentActor.get_eligibility();
      setEligibility(info);
      setIsFollowing(info.following);
    } catch (err) {
      console.error("Failed to fetch eligibility:", err);
    }
  };

  const fetchVoteHistory = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const list = await currentActor.list_vote_history();
      setVoteHistory(list);
    } catch (err) {
      console.error("Failed to fetch vote history:", err);
    }
  };

  const fetchMyCommitments = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const list = await currentActor.get_my_commitments();
      setMyCommitments(list);
    } catch (err) {
      console.error("Failed to fetch commitments:", err);
    }
  };

  const fetchSystemHealth = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const cycles = await currentActor.get_cycle_balance();
      setCycleBalance(cycles);

      // F-107: get_treasury_balance is admin-gated. Non-admin callers will
      // hit the require_admin guard; silently skip in that case so the rest
      // of the system-health panel still renders.
      try {
        const treasuryRes = await currentActor.get_treasury_balance();
        if ("Ok" in treasuryRes) {
          setTreasuryBalance(treasuryRes.Ok);
        } else {
          setTreasuryBalance(null);
        }
      } catch {
        setTreasuryBalance(null);
      }
    } catch (err) {
      console.error("Failed to fetch system health:", err);
    }
  };

  const fetchGlobalStats = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      // PB-115: app-wide totals (TVL, total burned, votes cast). Public
      // query — safe to call for anonymous viewers.
      const stats = await currentActor.get_global_stats();
      setGlobalStats(stats);
    } catch (err) {
      console.error("Failed to fetch global stats:", err);
    }
  };

  // PB-116: the leader neuron is whatever the backend is configured with —
  // never a hard-coded literal. On mainnet this is pinned to the production neuron.
  const fetchConfig = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const cfg = await currentActor.get_config();
      setConfig(cfg);
    } catch (err) {
      console.error("Failed to fetch config:", err);
    }
  };

  const fetchLeaderInfo = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const info = await currentActor.get_leader_neuron_info();
      setLeaderInfo(info);
    } catch (err) {
      console.error("Failed to fetch leader neuron info:", err);
    }
  };

  const refreshAllData = async () => {
    if (!actor) return;
    setIsLoading(true);
    try {
      await Promise.all([
        refreshEligibility(actor),
        fetchVoteHistory(actor),
        fetchMyCommitments(actor),
        fetchSystemHealth(actor),
        fetchGlobalStats(actor),
        fetchConfig(actor),
        fetchLeaderInfo(actor),
        actor.list_active_proposals().then((list: Proposal[]) => setProposals(list)),
      ]);
      // Also fetch balance
      if (principal && !principal.isAnonymous() && identity) {
        const ledgerActor = createLedgerActor(ledgerCanisterId, {
          agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
        });
        const bal = await ledgerActor.icrc1_balance_of({ owner: principal });
        setHoldings(bal);
      }
    } catch (err) {
      console.error("Failed to refresh data:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const getProposalTitle = (proposalId: bigint) => {
    const p = proposals.find(x => x.id === proposalId);
    if (p) return p.title;
    const historical: Record<string, string> = {
      "138300": "Increase replica memory ceiling to 8 GiB",
      "138250": "Deprecate legacy ledger archive canister",
      "138200": "Fund developer-grant round 7 (40k ICP)"
    };
    return historical[proposalId.toString()] || `Proposal #${proposalId}`;
  };

  const handleFollowNeuron = async () => {
    if (!actor || isVerifying) return;
    // Parse the user's OWN neuron id (u64 — keep as BigInt, never Number).
    let userNeuronId: bigint;
    try {
      userNeuronId = BigInt((neuronIdInput || "").trim());
    } catch {
      alert("Enter a valid neuron ID (digits only).");
      return;
    }
    if (userNeuronId <= 0n) {
      alert("Enter a valid neuron ID.");
      return;
    }
    setIsVerifying(true);
    try {
      // register_neuron verifies on-chain that THIS neuron is controlled by the
      // caller and follows the leader neuron. Requires the user to have added
      // this app's canister as a hotkey on their neuron first.
      const res = await actor.register_neuron(userNeuronId);
      if (res.__kind__ === "Ok") {
        setIsFollowing(true);
        await refreshEligibility();
        await fetchSystemHealth();
      } else {
        alert(`Verification failed: ${res.Err}`);
      }
    } catch (err: any) {
      console.error("Failed to verify follow:", err);
      alert(`Error verifying follow: ${err.message || err}`);
    } finally {
      setIsVerifying(false);
    }
  };

  // Deriving the tier dynamically
  const tier = !principal || principal.isAnonymous()
    ? 0
    : !isFollowing
    ? 1
    : (myCommitments.length > 0 || (eligibility?.has_committed ?? false))
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

  // Fetch Eligibility and Vote History when Actor changes
  useEffect(() => {
    if (!actor) return;
    refreshEligibility(actor);
    fetchVoteHistory(actor);
    fetchMyCommitments(actor);
    fetchSystemHealth(actor);
    fetchGlobalStats(actor);
    fetchConfig(actor);
    fetchLeaderInfo(actor);
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
    setIsSigningIn(true);
    await authClient.login({
      identityProvider: identityProviderUrl,
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
        setIsSigningIn(false);
      },
      onError: () => setIsSigningIn(false),
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
    setEligibility(null);
    setVoteHistory([]);
    setHoldings(0n);
    setMyCommitments([]);
    setCycleBalance(null);
    setTreasuryBalance(null);
  };

  // Handle Neuron Copy
  const handleCopy = () => {
    if (!config) return;
    navigator.clipboard.writeText(config.primary_neuron_id.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Open modal with stance pre-selected; amount is entered inside the modal
  const handleCommitClick = (proposalId: bigint, stance: Stance) => {
    setConfirmProposalId(proposalId);
    setConfirmStance(stance);
    setConfirmAmount("");
    setIsConfirming(true);
    setTxSuccess(false);
    setTxError(null);
    setTxStep("");
  };

  // Execute actual ledger + escrow saga
  const executeTransaction = async () => {
    if (!actor || !confirmProposalId || !confirmStance) return;

    const amount = parseFloat(confirmAmount);
    if (isNaN(amount) || amount < 1.0) {
      setTxError("Please enter a valid amount (minimum 1.0 ICP).");
      return;
    }
    const amountE8s = BigInt(Math.floor(amount * 100_000_000));
    const neuronStakeCap = eligibility?.holdings_e8s ?? 0n;
    if (neuronStakeCap > 0n && amountE8s > neuronStakeCap) {
      setTxError(`Exceeds your neuron stake cap of ${fmtICP(neuronStakeCap)} ICP.`);
      return;
    }
    const requiredTotal = amountE8s + 530_000n;
    if (requiredTotal > holdings) {
      setTxError(`Insufficient wallet balance — need at least ${fmtICP(requiredTotal)} ICP (amount + fees).`);
      return;
    }

    const requiredDeposit = amountE8s + 520_000n;
    setIsTransacting(true);
    setTxError(null);
    
    try {
      // Step 1: Get deterministic escrow address
      setTxStep("Deriving secure escrow subaccount...");
      const depositAccount = await actor.get_deposit_address(confirmProposalId);
      
      // Step 2: Transfer funds using ledger canister actor
      setTxStep("Step 1/2: Depositing ICP into escrow subaccount...");
      const ledgerActor = createLedgerActor(ledgerCanisterId, {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });

      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: depositAccount.owner,
          subaccount: depositAccount.subaccount ? depositAccount.subaccount : undefined
        },
        amount: requiredDeposit,
      });

      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err;
        const kind = err.__kind__;
        const detail =
          kind === "BadFee"        ? `expected fee ${fmtICP((err as any).BadFee.expected_fee)} ICP` :
          kind === "InsufficientFunds" ? `balance is ${fmtICP((err as any).InsufficientFunds.balance)} ICP` :
          kind === "TooOld"        ? "transaction window expired" :
          kind === "CreatedInFuture" ? "clock skew — try again" :
          kind === "Duplicate"     ? `duplicate of block ${(err as any).Duplicate.duplicate_of}` :
          kind === "TemporarilyUnavailable" ? "ledger temporarily unavailable" :
          kind === "GenericError"  ? (err as any).GenericError.message :
          JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Ledger transfer failed (${kind}): ${detail}`);
      }

      // Step 3: Finalize commit on backend
      setTxStep("Step 2/2: Finalizing commitment on-chain...");
      const commitResult = await actor.commit(confirmProposalId, confirmStance, amountE8s);

      if (commitResult.__kind__ === "Err") {
        throw new Error(`Commit registration failed: ${commitResult.Err}`);
      }

      // Success!
      setTxSuccess(true);
      setTxStep("Commitment finalized successfully!");
      
      // Refresh data
      await refreshAllData();
      
    } catch (err: any) {
      console.error("Transaction error:", err);
      setTxError(err.message || String(err));
    } finally {
      setIsTransacting(false);
    }
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
  const totalCommitted = myCommitments
    .filter(c => c.status === CommitmentStatus.Pending || c.status === CommitmentStatus.ThresholdMet || c.status === CommitmentStatus.FailedBurn)
    .reduce((sum, c) => sum + c.amount_e8s, 0n);

  const totalBurned = myCommitments
    .filter(c => c.status === CommitmentStatus.Burned)
    .reduce((sum, c) => sum + c.amount_e8s, 0n);

  const proposalsJoined = new Set(myCommitments.map(c => c.proposal_id.toString())).size;

  // Partition proposals into three display buckets
  const ACTIVE_STATUSES = new Set([
    CommitmentStatus.Pending, CommitmentStatus.ThresholdMet,
    CommitmentStatus.FailedBurn, CommitmentStatus.FailedRefund,
  ]);
  const SETTLED_STATUSES = new Set([CommitmentStatus.Burned, CommitmentStatus.Returned]);

  const openProposals = proposals.filter(p => {
    const c = myCommitments.find(m => m.proposal_id === p.id);
    return !c && (p.status === 'open' || p.status === 'met');
  });
  const committedProposals = proposals.filter(p => {
    const c = myCommitments.find(m => m.proposal_id === p.id);
    return c && ACTIVE_STATUSES.has(c.status);
  });
  const historyProposals = proposals.filter(p => {
    const c = myCommitments.find(m => m.proposal_id === p.id);
    return (c && SETTLED_STATUSES.has(c.status)) ||
           (!c && (p.status === 'voted' || p.status === 'settled' || p.status === 'abstained'));
  });

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
            Proof of Burn - Alpha
          </b>
        </div>

        <div className="row" style={{ gap: 16 }}>
          <Btn variant="ghost" sm onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
            <Icon name="spark" size={14} /> Theme: {theme.toUpperCase()}
          </Btn>

          {!principal || principal.isAnonymous() ? (
            <Btn variant="primary" sm onClick={handleLogin} disabled={isSigningIn}>
              {isSigningIn ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="key" size={14} stroke="var(--char-950)" />}
              {isSigningIn ? " Opening Internet Identity..." : " Sign in"}
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

            {/* ── Your activity (Tier 3) — PRIMARY, prominent ──
                Personal stats matter more than site-wide totals, so when the
                user has activity this renders first as the bold hero strip. */}
            {tier >= 3 && (
              <Reveal delay={30} motion={motion}>
                <div className="col" style={{ gap: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <Icon name="wallet" size={13} stroke="var(--burn)" />
                    <Eyebrow>Your activity</Eyebrow>
                  </div>
                  <div className="row" data-testid="user-stats-strip" style={{
                    border: '1px solid var(--burn)', borderRadius: 12, background: 'var(--burn-950)',
                    padding: '18px 8px', boxShadow: '0 0 0 1px color-mix(in srgb, var(--burn) 25%, transparent)'
                  }}>
                    <div className="col" style={{ gap: 4, flex: 1, alignItems: 'center', textAlign: 'center' }}>
                      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <Icon name="coins" size={16} stroke="var(--burn)" />
                        <span className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
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
                        <Icon name="flame" size={16} stroke="var(--burn)" />
                        <span className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
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
                        <Icon name="checkCircle" size={16} stroke="var(--burn)" />
                        <span className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                          {proposalsJoined}
                        </span>
                      </span>
                      <Eyrow>Proposals joined</Eyrow>
                    </div>
                  </div>
                </div>
              </Reveal>
            )}

            {/* ── Protocol totals — SECONDARY, compact & muted ──
                Public site-wide data. Rendered as a slim, subdued single-line bar
                so it never competes with the user's own stats above. */}
            <Reveal delay={40} motion={motion}>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow style={{ color: 'var(--fg-3)' }}>Protocol totals · all participants</Eyebrow>
                <div className="row" data-testid="global-stats-strip" style={{
                  border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-alt)',
                  padding: '10px 14px', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'
                }}>
                  <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                    <span>TVL</span>
                    <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>
                      {globalStats ? `${fmtICP(globalStats.tvl_e8s)} ICP` : "…"}
                    </span>
                  </span>
                  <span style={{ color: 'var(--border-hi)' }}>·</span>
                  <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                    <span>Burned</span>
                    <span className="mono" style={{ fontSize: 14, color: 'var(--burn-300)' }}>
                      {globalStats ? `${fmtICP(globalStats.total_burned_e8s)} ICP` : "…"}
                    </span>
                  </span>
                  <span style={{ color: 'var(--border-hi)' }}>·</span>
                  <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                    <span>Votes cast</span>
                    <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>
                      {globalStats ? globalStats.votes_cast.toString() : "…"}
                    </span>
                  </span>
                </div>
              </div>
            </Reveal>

            {/* ── Tagline ── */}
            <Reveal delay={50} motion={motion}>
              <div className="col" style={{ gap: 10 }}>
                <p style={{ fontSize: 22, lineHeight: 1.25, fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--fg)', margin: 0, textWrap: 'balance' }}>
                  Deflationary Power,<br />
                  <span style={{ color: 'var(--burn)' }}>Direct Control</span>
                </p>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)', margin: 0, maxWidth: 480 }}>
                  Signal conviction on key NNS proposals. Your burned ICP directly steers governance decisions while permanently shrinking the circulating supply to benefit every holder.
                </p>
              </div>
            </Reveal>

            {/* ── PB-071: Neuron Identity Block ── */}
            <Reveal delay={70} motion={motion}>
              <div className="card col" style={{ gap: 13 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div className="col" style={{ gap: 7, minWidth: 0 }}>
                    <Eyrow>Follow this neuron</Eyrow>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="mono" style={{ fontSize: 18, color: 'var(--fg)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                        Neuron {formatNeuronId(config?.primary_neuron_id)}
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
                      Community Leader Neuron
                    </span>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {leaderInfo && leaderInfo.voting_power > 0n
                        ? `${fmtVP(leaderInfo.voting_power)} Voting Power`
                        : "… Voting Power"}
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
                        <Icon name="arrowUp" size={13} stroke="var(--burn)" /> Sign in to verify
                      </span>
                    ) : (
                      <span className="row" style={{ gap: 6, color: 'var(--fg-3)', fontSize: 12.5, whiteSpace: 'nowrap' }}>
                        <Icon name="lock" size={13} stroke="var(--fg-3)" /> Not verified
                      </span>
                    )
                  ) : (
                    <span className="row" style={{ gap: 6, color: 'var(--sprout)', fontSize: 12.5 }}>
                      <Icon name="checkCircle" size={13} stroke="var(--sprout)" /> Verified on-chain
                    </span>
                  )}
                </div>

                {/* Guided on-chain verification: prove the user owns a neuron
                    that follows the leader. Real verification (controller==caller
                    + follows leader) happens in register_neuron on the backend. */}
                {principal && !principal.isAnonymous() && !isFollowing && (
                  <div className="col" style={{
                    gap: 12, marginTop: 12, paddingTop: 14, borderTop: '1px solid var(--border)'
                  }}>
                    <Eyrow>Verify your neuron</Eyrow>

                    <div className="col" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                      <span><b style={{ color: 'var(--fg)' }}>1.</b> In the NNS, set your neuron to <b>follow neuron {formatNeuronId(config?.primary_neuron_id)}</b> on Governance.</span>
                      <span><b style={{ color: 'var(--fg)' }}>2.</b> Add this app as a <b>hotkey</b> on your neuron so it can read it on-chain:</span>
                    </div>

                    {/* Hotkey = this app's backend canister principal */}
                    <div className="row" style={{
                      gap: 8, alignItems: 'center', justifyContent: 'space-between',
                      padding: '8px 10px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)'
                    }}>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {backendCanisterId}
                      </span>
                      <button onClick={() => {
                        navigator.clipboard.writeText(backendCanisterId);
                        setHotkeyCopied(true);
                        setTimeout(() => setHotkeyCopied(false), 2000);
                      }} title="Copy hotkey principal" style={{
                        display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0,
                        borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer'
                      }}>
                        <Icon name={hotkeyCopied ? "check" : "copy"} size={12} stroke={hotkeyCopied ? "var(--sprout)" : "var(--fg-3)"} />
                      </button>
                    </div>

                    <div className="col" style={{ gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}><b style={{ color: 'var(--fg)' }}>3.</b> Enter your neuron ID and verify:</span>
                      <div className="row" style={{ gap: 8 }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="Your neuron ID"
                          className="burn-input"
                          style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
                          value={neuronIdInput}
                          onChange={(e) => setNeuronIdInput(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                        <Btn variant="primary" sm onClick={handleFollowNeuron} disabled={isVerifying || !neuronIdInput}>
                          {isVerifying ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />}
                          {isVerifying ? " Verifying…" : " Verify"}
                        </Btn>
                      </div>
                      <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                        <Icon name="info" size={12} stroke="var(--fg-3)" /> We check on-chain that this neuron is yours and follows the leader.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </Reveal>

            {/* ── Three-section proposal list ── */}
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-3)' }}>
                <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
                Fetching active NNS proposals...
              </div>
            ) : (
              <div className="col" style={{ gap: 28 }}>

              {/* ── OPEN ── */}
              <div className="col" style={{ gap: 12 }}>
                <Reveal delay={100} motion={motion}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <LiveDot on={motion !== 'off'} color="var(--sprout)" size={7} />
                      <b style={{ fontSize: 14, color: 'var(--fg)' }}>Open</b>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {openProposals.length}</span>
                    </span>
                    <Eyebrow style={{ whiteSpace: 'nowrap' }}>vote your stance</Eyebrow>
                  </div>
                </Reveal>
                {openProposals.length === 0 && !isLoading && (
                  <div style={{ padding: '12px 0', color: 'var(--fg-3)', fontSize: 13 }}>No open proposals right now.</div>
                )}
                {openProposals.map((p, i) => {
                  const showBurn = tier >= 1;
                  const canCommit = tier >= 2;
                  const proposalIdStr = p.id.toString();
                  const aiReview = aiReviews[proposalIdStr];
                  const aiOpen = aiOpenMap[proposalIdStr] || (aiMode === 'expanded' && i === 0);

                  const pct = Math.floor((Number(p.total_committed_e8s) / Number(p.threshold_e8s)) * 100);
                  const met = p.status === 'met' || p.total_committed_e8s >= p.threshold_e8s;

                  const committedLabel = `${fmtICP(p.total_committed_e8s)} ICP committed`;
                  const reqLabel = pct > 100 ? `${pct}% · oversubscribed` : met ? `${pct}% · met` : `${pct}% of ${fmtICP(p.threshold_e8s)} ICP`;

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

                  const myCommitment = myCommitments.find(c => c.proposal_id === p.id);
                  const mineBadgeTone = myCommitment
                    ? myCommitment.status === CommitmentStatus.Burned ? "burn"
                    : myCommitment.status === CommitmentStatus.Returned ? "ok"
                    : (myCommitment.status === CommitmentStatus.FailedBurn || myCommitment.status === CommitmentStatus.FailedRefund) ? "danger"
                    : met ? "burn" : "dashed"
                    : "dashed";
                  const mineBadge = myCommitment && (
                    <Chip tone={mineBadgeTone}>
                      {myCommitment.status === CommitmentStatus.Burned ? (
                        <><Icon name="flame" size={11} stroke="var(--burn)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP → Cycles</>
                      ) : myCommitment.status === CommitmentStatus.Returned ? (
                        <><Icon name="checkCircle" size={11} stroke="var(--sprout)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP Returned</>
                      ) : (myCommitment.status === CommitmentStatus.FailedBurn || myCommitment.status === CommitmentStatus.FailedRefund) ? (
                        <><Icon name="x" size={11} /> Settlement error — retrying</>
                      ) : met ? (
                        <><Icon name="flame" size={11} stroke="var(--burn)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP burning soon</>
                      ) : (
                        <>You · {fmtICP(myCommitment.amount_e8s)} ICP pending ({myCommitment.stance === Stance.Adopt ? "ADOPT" : "REJECT"})</>
                      )}
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
                              <Btn variant="primary" sm style={{ flex: 1, background: 'var(--sprout-dim)', color: 'var(--sprout)', border: '1px solid var(--sprout)' }} disabled>
                                <Icon name="checkCircle" size={13} stroke="var(--sprout)" /> ADOPT
                              </Btn>
                              <Btn variant="danger" sm style={{ flex: 1 }} disabled>
                                <Icon name="x" size={13} /> REJECT
                              </Btn>
                            </div>
                          </Gate>
                        )}

                        {canCommit && (
                          <div className="col" style={{ gap: 10 }}>
                            <div className="row" style={{ gap: 8 }}>
                              <Btn
                                variant="primary"
                                sm
                                style={{ flex: 1, background: 'var(--sprout-dim)', color: 'var(--sprout)', border: '1px solid var(--sprout)' }}
                                onClick={() => handleCommitClick(p.id, Stance.Adopt)}
                              >
                                <Icon name="checkCircle" size={13} stroke="var(--sprout)" /> ADOPT
                              </Btn>
                              <Btn
                                variant="danger"
                                sm
                                style={{ flex: 1 }}
                                onClick={() => handleCommitClick(p.id, Stance.Reject)}
                              >
                                <Icon name="x" size={13} /> REJECT
                              </Btn>
                            </div>

                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                              <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-2)', flexWrap: 'wrap' }}>
                                <span className="row" style={{ gap: 4 }}>
                                  <Icon name="coins" size={12} stroke="var(--fg-3)" />
                                  <span>Wallet: <span className="mono" style={{ color: 'var(--fg)' }}>{fmtICP(holdings)}</span></span>
                                </span>
                                {eligibility?.holdings_e8s && eligibility.holdings_e8s > 0n && (
                                  <span className="row" style={{ gap: 4 }}>
                                    <span style={{ color: 'var(--fg-3)' }}>·</span>
                                    <span>Stake cap: <span className="mono" style={{ color: 'var(--fg)' }}>{fmtICP(eligibility.holdings_e8s)}</span></span>
                                  </span>
                                )}
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
                              <Icon name="info" size={12} stroke="var(--fg-3)" /> No conversion if threshold misses — committed ICP is returned.
                            </span>
                          </div>
                        )}
                      </div>
                    </Reveal>
                  );
                })}
              </div>{/* end openProposals */}

              {/* ── COMMITTED ── */}
              {tier >= 2 && (
                <div className="col" style={{ gap: 12 }}>
                  <Reveal delay={120} motion={motion}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                      <span className="row" style={{ gap: 8 }}>
                        <Icon name="flame" size={13} stroke="var(--burn)" />
                        <b style={{ fontSize: 14, color: 'var(--fg)' }}>Committed</b>
                        <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {committedProposals.length}</span>
                      </span>
                      <Eyebrow style={{ whiteSpace: 'nowrap' }}>your active stake</Eyebrow>
                    </div>
                  </Reveal>
                  {committedProposals.length === 0 ? (
                    <div style={{ padding: '12px 0', color: 'var(--fg-3)', fontSize: 13 }}>No active commitments yet.</div>
                  ) : committedProposals.map((p, _i) => {
                    const myCommitment = myCommitments.find(c => c.proposal_id === p.id)!;
                    const pct = Math.floor((Number(p.total_committed_e8s) / Number(p.threshold_e8s)) * 100);
                    const met = p.status === 'met' || p.total_committed_e8s >= p.threshold_e8s;
                    const remainingNs = Number(p.deadline) - Date.now() * 1_000_000;
                    const remainingH = Math.max(0, Math.floor(remainingNs / (3600 * 1_000_000_000)));
                    const remainingD = Math.floor(remainingH / 24);
                    const deadlineStr = remainingD > 0 ? `${remainingD}d ${remainingH % 24}h` : `${remainingH}h`;
                    const isRetrying = myCommitment.status === CommitmentStatus.FailedBurn || myCommitment.status === CommitmentStatus.FailedRefund;
                    return (
                      <Reveal key={p.id.toString()} delay={140} motion={motion}>
                        <div className="col" style={{
                          gap: 10, border: `1px solid ${met ? 'var(--burn)' : 'var(--border)'}`,
                          borderRadius: 8, background: 'var(--surface)', padding: 14
                        }}>
                          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                            <div className="col" style={{ gap: 5, minWidth: 0, flex: 1 }}>
                              <Chip tone="muted" style={{ height: 18, fontSize: 10.5, alignSelf: 'flex-start' }}>{p.category}</Chip>
                              <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--fg)', textWrap: 'pretty' }}>{p.title}</span>
                            </div>
                            <div className="col" style={{ alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                              <Chip tone="muted" style={{ height: 20 }}><Icon name="clock" size={11} /> {deadlineStr}</Chip>
                              {met
                                ? <Chip tone="burn"><Icon name="flame" size={11} stroke="var(--burn)" /> Threshold met</Chip>
                                : <Chip tone="muted"><LiveDot on={motion !== 'off'} /> Open</Chip>}
                            </div>
                          </div>
                          <HeatBar pct={pct} committed={`${fmtICP(p.total_committed_e8s)} ICP`} req={met ? `${pct}% · met` : `${pct}% of ${fmtICP(p.threshold_e8s)} ICP`} met={met} />
                          <div style={{ borderTop: '1px solid var(--border)' }} />
                          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <span className="row" style={{ gap: 8, fontSize: 12.5 }}>
                              <span style={{ color: 'var(--fg-3)' }}>Your commitment</span>
                              <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtICP(myCommitment.amount_e8s)} ICP</span>
                              <Chip tone={myCommitment.stance === Stance.Adopt ? 'ok' : 'danger'} style={{ height: 18, fontSize: 10.5 }}>
                                {myCommitment.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'}
                              </Chip>
                            </span>
                            {isRetrying && (
                              <Chip tone="danger" style={{ fontSize: 11 }}><Icon name="x" size={10} /> Error — retrying</Chip>
                            )}
                          </div>
                          <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                            <Icon name="info" size={12} stroke="var(--fg-3)" />
                            {met
                              ? 'Threshold met — ICP will convert to cycles when the canister votes.'
                              : 'No conversion if threshold misses — committed ICP is returned.'}
                          </span>
                        </div>
                      </Reveal>
                    );
                  })}
                </div>
              )}

              {/* ── HISTORY ── */}
              <div className="col" style={{ gap: 12 }}>
                <Reveal delay={160} motion={motion}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <Icon name="list" size={13} stroke="var(--fg-2)" />
                      <b style={{ fontSize: 14, color: 'var(--fg)' }}>History</b>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {historyProposals.length + (tier >= 1 ? voteHistory.filter(r => !historyProposals.find(p => p.id === r.proposal_id)).length : 0)}</span>
                    </span>
                    <Eyebrow style={{ whiteSpace: 'nowrap' }}>settled · cycles · returned</Eyebrow>
                  </div>
                </Reveal>

                {tier < 1 ? (
                  <Gate hint="Sign in to unlock" height={80} gating={gating}>
                    <div style={{ height: 60 }} />
                  </Gate>
                ) : historyProposals.length === 0 && voteHistory.length === 0 ? (
                  <div style={{ padding: '12px 0', color: 'var(--fg-3)', fontSize: 13 }}>No settled proposals yet.</div>
                ) : (
                  <div className="col" style={{ gap: 0 }}>
                    {/* Proposals where the user committed and it settled */}
                    {historyProposals.map((p, _i) => {
                      const myCommitment = myCommitments.find(c => c.proposal_id === p.id);
                      const voteRec = voteHistory.find(r => r.proposal_id === p.id);
                      const isBurned = myCommitment?.status === CommitmentStatus.Burned;
                      return (
                        <div key={p.id.toString()} className="col" style={{
                          gap: 8, padding: '12px 0',
                          borderBottom: '1px solid var(--border)'
                        }}>
                          <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                            <span style={{ fontSize: 13, color: 'var(--fg-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={p.title}>
                              {p.title}
                            </span>
                            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                              {voteRec && (
                                <Chip tone={voteRec.vote === Vote.Yes ? 'ok' : 'muted'} style={{ height: 20, fontSize: 11 }}>
                                  {voteRec.vote === Vote.Yes ? 'voted yes' : voteRec.vote === Vote.No ? 'voted no' : 'abstained'}
                                </Chip>
                              )}
                            </div>
                          </div>
                          {myCommitment && (
                            <div className="row" style={{ gap: 10, fontSize: 12, color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                              <Chip tone={myCommitment.stance === Stance.Adopt ? 'ok' : 'danger'} style={{ height: 17, fontSize: 10 }}>
                                {myCommitment.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'}
                              </Chip>
                              <span className="mono" style={{ color: isBurned ? 'var(--burn)' : 'var(--sprout)' }}>
                                {fmtICP(myCommitment.amount_e8s)} ICP {isBurned ? '→ cycles' : 'returned'}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {/* Canister-level votes where user didn't personally commit */}
                    {voteHistory
                      .filter(r => !historyProposals.find(p => p.id === r.proposal_id))
                      .map((record, _i) => {
                        const title = getProposalTitle(record.proposal_id);
                        const voteStr = record.vote === Vote.Yes ? 'voted yes' : record.vote === Vote.No ? 'voted no' : 'abstained';
                        return (
                          <div key={record.proposal_id.toString()} className="row" style={{
                            justifyContent: 'space-between', gap: 12, padding: '12px 0',
                            borderBottom: '1px solid var(--border)'
                          }}>
                            <span style={{ fontSize: 13, color: 'var(--fg-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={title}>
                              {title}
                            </span>
                            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                              <Chip tone={record.vote === Vote.Yes ? 'ok' : 'muted'} style={{ height: 20, fontSize: 11 }}>{voteStr}</Chip>
                              <span className="mono" style={{ fontSize: 11.5, color: 'var(--burn)' }}>{fmtICP(record.icp_burned_e8s)} → cycles</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              </div>
            )}
          </div>
        </main>

        {/* Right Column: Tweak panel & Progression Ladder — local dev only */}
        {isLocal && <aside style={{
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

          {/* System Health Section */}
          <div className="col" style={{ gap: 12 }}>
            <Eyebrow>System Health</Eyebrow>
            <div className="col" style={{ gap: 8, fontSize: 13 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--fg-2)' }}>Canister Cycles</span>
                <span className="mono">
                  {cycleBalance !== null ? `${(Number(cycleBalance) / 1_000_000_000_000).toFixed(2)} T` : "..."}
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--fg-2)' }}>Treasury Balance</span>
                <span className="mono">
                  {treasuryBalance !== null ? `${fmtICP(treasuryBalance)} ICP` : "..."}
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <span style={{ color: 'var(--fg-2)', fontSize: 12.5 }}>Status</span>
                <span className="row" style={{ gap: 6, fontSize: 12.5, color: 'var(--sprout)' }}>
                  <LiveDot color="var(--sprout)" size={6} /> Active / Healthy
                </span>
              </div>
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

          {/* Local dev faucet — hidden on mainnet by the backend */}
          {principal && !principal.isAnonymous() && (
            <div className="simulator-panel col">
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>Dev Faucet</span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>Send 100 real test ICP to your wallet from the canister.</span>
              <Btn variant="secondary" sm onClick={async () => {
                if (!actor) return;
                try {
                  const res = await actor.dev_faucet();
                  if (res.__kind__ === "Err") {
                    alert(`Faucet error: ${res.Err}`);
                    return;
                  }
                  await refreshAllData();
                } catch (e: any) {
                  alert(`Faucet failed: ${e.message || e}`);
                }
              }}>
                <Icon name="zap" size={12} stroke="var(--burn)" /> Get 100 ICP
              </Btn>
            </div>
          )}
        </aside>}

      </div>

      {/* ── Transaction Confirmation Modal ── */}
      {isConfirming && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 440, width: '100%', gap: 20, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="flame" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Confirm Conviction Burn</h4>
              </span>
              {!isTransacting && (
                <button onClick={() => setIsConfirming(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)'
                }}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            {txError && (
              <div style={{
                padding: 12, borderRadius: 6, background: 'var(--ember-dim)',
                border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 13,
                lineHeight: 1.4
              }}>
                <b>Transaction Failed:</b> {txError}
              </div>
            )}

            {txSuccess ? (
              <div className="col" style={{ alignItems: 'center', textAlign: 'center', gap: 14, padding: '10px 0' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 999, background: 'var(--sprout-dim)',
                  border: '1px solid var(--sprout)', display: 'grid', placeItems: 'center',
                  color: 'var(--sprout)'
                }}>
                  <Icon name="checkCircle" size={24} stroke="var(--sprout)" />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <h5 style={{ margin: 0, color: 'var(--fg)' }}>Commitment Registered!</h5>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
                    Your {confirmAmount} ICP is locked in escrow. If the proposal reaches threshold, it will be <b>permanently burned</b> — removed from the ICP supply forever as proof of your conviction.
                  </p>
                </div>
                <Btn variant="primary" style={{ width: '100%', marginTop: 8 }} onClick={() => setIsConfirming(false)}>
                  Close
                </Btn>
              </div>
            ) : (
              <div className="col" style={{ gap: 16 }}>
                {/* Proposal + stance summary */}
                <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>PROPOSAL</span>
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--fg)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {getProposalTitle(confirmProposalId || 0n)}
                  </span>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>YOUR STANCE</span>
                    <Chip tone={confirmStance === Stance.Adopt ? "ok" : "danger"} style={{ height: 20, fontSize: 11 }}>
                      {confirmStance === Stance.Adopt
                        ? <><Icon name="checkCircle" size={11} stroke="var(--sprout)" /> ADOPT</>
                        : <><Icon name="x" size={11} /> REJECT</>}
                    </Chip>
                  </div>
                </div>

                {/* Amount input */}
                <div className="col" style={{ gap: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
                    How much ICP to burn?
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      placeholder="0.0"
                      className="burn-input"
                      style={{ fontSize: 22, padding: '10px 52px 10px 14px', fontFamily: 'var(--font-mono)' }}
                      value={confirmAmount}
                      onChange={(e) => { setConfirmAmount(e.target.value); setTxError(null); }}
                      autoFocus
                    />
                    <span className="mono" style={{
                      position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                      fontSize: 14, color: 'var(--fg-3)', pointerEvents: 'none'
                    }}>ICP</span>
                  </div>
                  {/* Inline limits */}
                  <div className="row" style={{ gap: 12, fontSize: 11.5, color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                    <span>Min: <span className="mono" style={{ color: 'var(--fg-2)' }}>1.0 ICP</span></span>
                    <span>Wallet: <span className="mono" style={{ color: 'var(--fg-2)' }}>{fmtICP(holdings)} ICP</span></span>
                    {eligibility?.holdings_e8s && eligibility.holdings_e8s > 0n && (
                      <span>Stake cap: <span className="mono" style={{ color: 'var(--fg-2)' }}>{fmtICP(eligibility.holdings_e8s)} ICP</span></span>
                    )}
                  </div>
                </div>

                {/* Live fee breakdown */}
                <div className="col" style={{ gap: 8, fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Target (→ Cycles)</span>
                    <span className="mono">{confirmAmount ? parseFloat(confirmAmount).toFixed(4) : "—"} ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Protocol fee</span>
                    <span className="mono">0.0050 ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Ledger fees</span>
                    <span className="mono">0.0003 ICP</span>
                  </div>
                  <hr />
                  <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
                    <span style={{ color: 'var(--fg)' }}>Total debit</span>
                    <span className="mono" style={{ color: confirmAmount ? 'var(--burn)' : 'var(--fg-3)' }}>
                      {confirmAmount ? (parseFloat(confirmAmount) + 0.0053).toFixed(4) : "—"} ICP
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
                  ⚠️ <b>Conviction is Final.</b> By confirming, you authorize a transfer from your wallet to a deterministic escrow subaccount. The 0.005 ICP protocol fee is consumed immediately. If the proposal threshold is met, the target ICP is sent to the Cycles Minting Canister — burned from the ICP supply and converted to cycles that fund this canister's operation. If threshold is not met, your ICP is returned (minus 0.0001 ICP ledger fee).
                </div>

                {isTransacting ? (
                  <div className="col" style={{ alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <LiveDot size={8} color="var(--burn)" />
                    <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{txStep}</span>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 12 }}>
                    <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setIsConfirming(false)}>
                      Cancel
                    </Btn>
                    <Btn
                      variant="primary"
                      style={{ flex: 1, opacity: confirmAmount && parseFloat(confirmAmount) >= 1 ? 1 : 0.45 }}
                      onClick={executeTransaction}
                    >
                      <Icon name="flame" size={14} stroke="var(--char-950)" /> Burn {confirmAmount ? `${parseFloat(confirmAmount).toFixed(1)} ICP` : "ICP"}
                    </Btn>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Simple type definitions helper
function Eyrow({ children }: { children: React.ReactNode }) {
  return <Eyebrow style={{ marginTop: 2 }}>{children}</Eyebrow>;
}
