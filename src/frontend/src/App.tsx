import React, { useState, useEffect } from 'react';
import { AuthClient } from "@icp-sdk/auth/client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  createActor as createBackendActor,
  Vote,
  Stance,
  CommitmentStatus,
  IdeaToken,
} from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type {
  Proposal,
  EligibilityInfo,
  VoteRecord,
  Commitment,
  GlobalStats,
  Config,
  LeaderNeuronInfo,
  PoolInfo,
  PoolNeuron,
  LedgerAccount,
  FeatureFlag,
  IdeaBoardInfo,
  UserStakeInfo,
  LosslessVote,
} from "./bindings/backend";
import IdeaBoard, { tokenMeta, parseTokenAmount, fmtTokenAmount, TOKEN_ORDER } from "./IdeaBoard";
import Staking from "./Staking";
import Lottery from "./Lottery";
import Payouts from "./Payouts";
import Admin from "./Admin";
// Shared design-system primitives live in ui.tsx (also used by IdeaBoard).
import { Icon, Eyebrow, Chip, Btn, LiveDot, fmtICP, formatPrincipal } from "./ui";

// Inline neuron glyph (from src/assets/neuron.svg). Rendered as inline SVG rather
// than an <img>, because Vite inlines small SVGs as data URIs and the `#` in the
// `#FF6A1F` fills breaks data-URI parsing (shows a broken image).
function NeuronGlyph({ size = 15, color = 'var(--burn)', style }: { size?: number; color?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', ...style }}>
      <g fill={color} stroke={color} strokeWidth="0.5" strokeLinejoin="round" strokeLinecap="round">
        <path fillRule="evenodd" d="M 32 30 C 28 26, 24 25, 20 23 C 22 26, 22 30, 24 33 C 21 34, 17 35, 13 36 C 18 38, 21 40, 23 41 C 21 45, 19 50, 16 54 C 20 52, 24 49, 27 46 C 30 50, 32 54, 34 58 C 34 53, 33 48, 32 44 C 36 43, 40 42, 44 42 C 40 39, 36 37, 34 35 C 36 32, 38 28, 41 24 C 37 27, 34 29, 32 30 Z M 28 37 A 3 3 0 1 0 28 37.01 Z" />
        <path d="M 20 23 Q 15 22, 12 17 Q 13 15, 10 14" fill="none" strokeWidth="1.2" />
        <path d="M 15 22 Q 13 24, 8 23" fill="none" strokeWidth="1" />
        <path d="M 13 36 Q 8 36, 5 33 Q 4 34, 2 33" fill="none" strokeWidth="1.2" />
        <path d="M 8 36 Q 6 39, 4 41" fill="none" strokeWidth="1" />
        <path d="M 16 54 Q 12 58, 10 63 Q 11 65, 8 68" fill="none" strokeWidth="1.2" />
        <path d="M 12 58 Q 9 58, 6 57" fill="none" strokeWidth="1" />
        <path d="M 41 24 Q 45 20, 48 15 Q 47 13, 50 9" fill="none" strokeWidth="1.2" />
        <path d="M 45 20 Q 48 22, 52 21" fill="none" strokeWidth="1" />
        <path d="M 34 58 Q 42 66, 50 72 Q 58 78, 66 82 Q 72 85, 78 87" fill="none" strokeWidth="2" />
        <rect x="36" y="58" width="10" height="6" rx="3" transform="rotate(38, 41, 61)" />
        <rect x="47" y="67" width="11" height="6" rx="3" transform="rotate(33, 52, 70)" />
        <rect x="58" y="74" width="11" height="6" rx="3" transform="rotate(27, 63, 77)" />
        <rect x="69" y="80" width="10" height="6" rx="3" transform="rotate(20, 74, 83)" />
        <path d="M 78 87 Q 84 89, 89 89" fill="none" strokeWidth="1.5" />
        <path d="M 89 89 Q 93 88, 95 86" fill="none" strokeWidth="1.2" />
        <path d="M 89 89 Q 91 92, 94 94" fill="none" strokeWidth="1.2" />
        <path d="M 78 87 Q 82 91, 84 95" fill="none" strokeWidth="1.5" />
        <path d="M 84 95 Q 86 97, 88 98" fill="none" strokeWidth="1.2" />
        <path d="M 84 95 Q 82 98, 80 99" fill="none" strokeWidth="1.2" />
        <circle cx="95" cy="86" r="1.2" />
        <circle cx="94" cy="94" r="1.2" />
        <circle cx="88" cy="98" r="1.2" />
        <circle cx="80" cy="99" r="1.2" />
      </g>
    </svg>
  );
}

// ==========================================
// 2. Base Helpers and UI components
// ==========================================

// PB-123: balance-of-power bar — ADOPT (yes) vs REJECT (no), weighted by ICP.
function BalanceOfPowerBar({ adopt, reject }: { adopt: bigint; reject: bigint }) {
  const total = adopt + reject;
  const adoptPct = total > 0n ? Number((adopt * 10000n) / total) / 100 : 50;
  const rejectPct = 100 - adoptPct;
  const empty = total === 0n;
  return (
    <div className="col" style={{ gap: 5 }}>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
        <span style={{ color: 'var(--sprout)' }}>ADOPT {empty ? "—" : `${adoptPct.toFixed(0)}%`}</span>
        <span style={{ color: 'var(--fg-3)' }}>balance of power</span>
        <span style={{ color: 'var(--ember)' }}>{empty ? "—" : `${rejectPct.toFixed(0)}%`} REJECT</span>
      </div>
      <div className="row" style={{ height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--char-800)' }}>
        {empty ? (
          <div style={{ width: '100%', height: '100%', background: 'var(--char-800)' }} />
        ) : (
          <>
            <div style={{ width: `${adoptPct}%`, height: '100%', background: 'var(--sprout)', transition: 'width .6s var(--ease-out)' }} />
            <div style={{ width: `${rejectPct}%`, height: '100%', background: 'var(--ember)', transition: 'width .6s var(--ease-out)' }} />
          </>
        )}
      </div>
    </div>
  );
}

// Lossless staking: free adopt/reject vote with staked weight. Joins the
// balance of power only — the burn threshold is untouched. Renders nothing
// for users without stake; shows the cast vote once made (immutable).
function LosslessVoteRow({ proposal, myVote, stakeE8s, voting, onVote }: {
  proposal: Proposal;
  myVote: LosslessVote | undefined;
  stakeE8s: bigint;
  voting: boolean;
  onVote: (proposalId: bigint, stance: Stance) => void;
}) {
  const hasLossless = proposal.lossless_adopt_e8s > 0n || proposal.lossless_reject_e8s > 0n;
  const breakdown = hasLossless ? (
    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
      incl. staked power: {fmtICP(proposal.lossless_adopt_e8s)} adopt / {fmtICP(proposal.lossless_reject_e8s)} reject
    </span>
  ) : null;

  if (myVote) {
    return (
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
          <Icon name="zap" size={11} stroke="var(--fg-3)" /> Your staked power
          <Chip tone={myVote.stance === Stance.Adopt ? 'ok' : 'danger'} style={{ height: 18, fontSize: 10.5 }}>
            {myVote.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'} · {fmtICP(myVote.weight_e8s)} ICP
          </Chip>
        </span>
        {breakdown}
      </div>
    );
  }
  const open = proposal.status === 'open' || proposal.status === 'met';
  if (stakeE8s <= 0n || !open) {
    return breakdown ? <div className="row" style={{ justifyContent: 'flex-end' }}>{breakdown}</div> : null;
  }
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
          <Icon name="zap" size={11} stroke="var(--burn)" /> Vote free with {fmtICP(stakeE8s)} voting power (stake × term)
        </span>
        <Btn
          variant="ghost" sm
          style={{ height: 22, fontSize: 11, color: 'var(--sprout)', border: '1px solid var(--sprout)' }}
          onClick={() => onVote(proposal.id, Stance.Adopt)} disabled={voting}
        >
          {voting ? <LiveDot size={6} /> : <Icon name="checkCircle" size={11} stroke="var(--sprout)" />} ADOPT
        </Btn>
        <Btn
          variant="ghost" sm
          style={{ height: 22, fontSize: 11, color: 'var(--ember)', border: '1px solid var(--ember)' }}
          onClick={() => onVote(proposal.id, Stance.Reject)} disabled={voting}
        >
          {voting ? <LiveDot size={6} /> : <Icon name="x" size={11} stroke="var(--ember)" />} REJECT
        </Btn>
      </span>
      {breakdown}
    </div>
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
function fmtFlipAmount(e8s: bigint): string {
  if (e8s === 0n) return "0.0";
  const num = Number(e8s) / 100_000_000;
  if (num < 0.1) {
    return num.toFixed(8).replace(/\.?0+$/, "");
  }
  return num.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function getFlipCalculation(adoptE8s: bigint, rejectE8s: bigint) {
  if (adoptE8s > rejectE8s) {
    const diff = adoptE8s - rejectE8s;
    return { toStance: 'Reject', amountE8s: diff + 1n };
  } else if (rejectE8s > adoptE8s) {
    const diff = rejectE8s - adoptE8s;
    return { toStance: 'Adopt', amountE8s: diff + 1n };
  } else {
    return { toStance: 'either', amountE8s: 1n };
  }
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

function getMinVotingPowerForTop25(poolInfo: PoolInfo | null): bigint {
  if (!poolInfo || poolInfo.active_neurons.length === 0) {
    return 0n;
  }
  const sorted = [...poolInfo.active_neurons].sort((a, b) => {
    if (a.voting_power > b.voting_power) return -1;
    if (a.voting_power < b.voting_power) return 1;
    return 0;
  });
  if (sorted.length <= 25) {
    return sorted[sorted.length - 1].voting_power;
  }
  return sorted[24].voting_power;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function isValidAccountId(hex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hex.trim());
}

// Candid variant check — avoids 'in' operator on union type (TypeScript strict mode TS2322)
function poolIs(status: PoolNeuron['status'], variant: 'Active' | 'Draft' | 'Inactive'): boolean {
  // The typed binding converts the candid variant to a string enum
  // (PoolStatus.Inactive === "Inactive"), so `status` is a plain string — not a
  // `{ Inactive: null }` object. Compare directly; key-indexing always returned
  // undefined, which made every poolIs() check false (no chips/buttons rendered).
  return (status as unknown as string) === variant;
}

// TIER META definition
const TIER_META = [
  ['Tier 0', 'Anonymous visitor', 'Minimum to understand + start', 'lands on the page'],
  ['Tier 1', 'Authenticated', 'Signed in via Internet Identity', 'signs in'],
  ['Tier 2', 'Follower', 'Self-attested follow of the leader neuron', 'follows the neuron'],
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

  const origin = window.location.origin;
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  // On mainnet the agent must talk to the IC API boundary, not the dapp's own
  // origin — otherwise every canister call fails. Locally, use the replica origin.
  const host = isLocal ? origin : "https://icp-api.io";
  // Hardcoded mainnet fallbacks so the app works even if the injected canister
  // env is missing (the prior "" fallback broke all backend calls on mainnet).
  const backendCanisterId = env?.['PUBLIC_CANISTER_ID:backend'] || (isLocal ? "aiewf-lx777-77775-aaaca-cai" : "k7dn6-qiaaa-aaaap-qutha-cai");
  const ledgerCanisterId = env?.['PUBLIC_CANISTER_ID:ledger'] || (isLocal ? "a5dhi-k7777-77775-aaabq-cai" : "ryjl3-tyaaa-aaaaa-aaaba-cai");
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
  const [isFollowModalOpen, setIsFollowModalOpen] = useState(false);
  const [nnsOpened, setNnsOpened] = useState(false);
  const [hotkeyCopied, setHotkeyCopied] = useState(false);
  const [eligibility, setEligibility] = useState<EligibilityInfo | null>(null);
  const [voteHistory, setVoteHistory] = useState<VoteRecord[]>([]);
  const [holdings, setHoldings] = useState<bigint>(0n);
  const [myCommitments, setMyCommitments] = useState<Commitment[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [leaderInfo, setLeaderInfo] = useState<LeaderNeuronInfo | null>(null);
  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(null);
  const [myPoolNeuron, setMyPoolNeuron] = useState<PoolNeuron | null>(null);
  const [poolSidebarCollapsed, setPoolSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('pool-sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [poolMobileOpen, setPoolMobileOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [poolDetailsOpen, setPoolDetailsOpen] = useState(false);
  const [dashControlsOpen, setDashControlsOpen] = useState(true);
  const [confirmLeaveId, setConfirmLeaveId] = useState<bigint | null>(null);
  const [isLeavingPool, setIsLeavingPool] = useState(false);
  const [isPoolWizardOpen, setIsPoolWizardOpen] = useState(false);
  const [poolWizardStep, setPoolWizardStep] = useState<1 | 2 | 3>(1);
  const [poolNeuronInput, setPoolNeuronInput] = useState('');
  const [poolVerifyError, setPoolVerifyError] = useState<string | null>(null);
  const [isPoolVerifying, setIsPoolVerifying] = useState(false);
  const [poolFinalizeError, setPoolFinalizeError] = useState<string | null>(null);
  const [isPoolFinalizing, setIsPoolFinalizing] = useState(false);
  const [poolFinalizeSuccess, setPoolFinalizeSuccess] = useState(false);
  const [isCancellingDraft, setIsCancellingDraft] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  // Wallet (deposit / withdraw) state
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const [accountId, setAccountId] = useState<string>("");
  const [addrCopied, setAddrCopied] = useState<"" | "aid" | "principal">("");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [withdrawSuccess, setWithdrawSuccess] = useState(false);

  // Transaction / Modal state
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransacting, setIsTransacting] = useState(false);
  const [txStep, setTxStep] = useState<string>("");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState(false);
  const [confirmProposalId, setConfirmProposalId] = useState<bigint | null>(null);
  const [confirmAmount, setConfirmAmount] = useState<string>("");
  const [confirmStance, setConfirmStance] = useState<Stance | null>(null);

  // Add-more modal state (top up existing commitment)
  const [isAddingMore, setIsAddingMore] = useState(false);
  const [addMoreProposalId, setAddMoreProposalId] = useState<bigint | null>(null);
  const [addMoreAmount, setAddMoreAmount] = useState("");
  const [addMoreTxStep, setAddMoreTxStep] = useState("");
  const [addMoreTxError, setAddMoreTxError] = useState<string | null>(null);
  const [addMoreTxSuccess, setAddMoreTxSuccess] = useState(false);
  const [isAddMoreTransacting, setIsAddMoreTransacting] = useState(false);

  // System health state
  const [cycleBalance, setCycleBalance] = useState<bigint | null>(null);
  const [treasuryBalance, setTreasuryBalance] = useState<bigint | null>(null);
  // Treasury Wallet (admin) modal
  const [isTreasuryOpen, setIsTreasuryOpen] = useState(false);
  const [treasuryWithdrawTo, setTreasuryWithdrawTo] = useState("");
  const [treasuryWithdrawAmount, setTreasuryWithdrawAmount] = useState("");
  const [isTreasuryWithdrawing, setIsTreasuryWithdrawing] = useState(false);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);
  const [treasurySuccess, setTreasurySuccess] = useState(false);

  // Tweak / simulator options
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [gating, setGating] = useState<string>('blur');
  const [aiMode, setAiMode] = useState<string>('hidden');
  const [motion, setMotion] = useState<string>('expressive');
  const [isDetailsOpen, setIsDetailsOpen] = useState<boolean>(false);

  // Input states for each proposal
  const [aiOpenMap, setAiOpenMap] = useState<Record<string, boolean>>({});

  // Neuron copy status
  const [copied, setCopied] = useState(false);
  const [skillsCopied, setSkillsCopied] = useState(false);

  // Active tab selection
  const [activeTab, setActiveTab] = useState<'open' | 'committed' | 'history'>('open');

  // Help modal status
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // Page routing (dashboard | Community R&D | Lossless Voting | Lottery |
  // Payout history) + feature flags
  const [page, setPage] = useState<'dashboard' | 'ideas' | 'staking' | 'lottery' | 'payouts' | 'admin'>('dashboard');
  const [featureFlags, setFeatureFlags] = useState<FeatureFlag[]>([]);

  // Feature flag: the Community R&D page + nav are fully hidden when disabled
  // (the backend also rejects its update methods, so this is belt + braces).
  const ideaBoardEnabled = featureFlags.find(f => f.key === 'idea_board')?.enabled ?? false;
  const losslessEnabled = featureFlags.find(f => f.key === 'lossless_voting')?.enabled ?? false;
  const lotteryEnabled = featureFlags.find(f => f.key === 'lossless_lottery')?.enabled ?? false;

  // Lossless staking: the caller's stake (= free voting power) and votes cast.
  const [myStake, setMyStake] = useState<UserStakeInfo | null>(null);
  const [myLosslessVotes, setMyLosslessVotes] = useState<LosslessVote[]>([]);
  const [losslessVoting, setLosslessVoting] = useState<bigint | null>(null);

  // Token-ledger info (drives the multi-token wallet + R&D board).
  const [boardInfo, setBoardInfo] = useState<IdeaBoardInfo | null>(null);
  const [tokenBalances, setTokenBalances] = useState<{ ckbtc: bigint | null; cketh: bigint | null }>({ ckbtc: null, cketh: null });
  const [walletToken, setWalletToken] = useState<IdeaToken>(IdeaToken.ICP);

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

  const fetchFeatureFlags = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      // Public query — drives nav visibility for everyone, toggles for admins.
      setFeatureFlags(await currentActor.list_feature_flags());
    } catch (err) {
      console.error("Failed to fetch feature flags:", err);
    }
  };

  const fetchBoardInfo = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      setBoardInfo(await currentActor.get_idea_board_info());
    } catch (err) {
      console.error("Failed to fetch board info:", err);
    }
  };

  // ckBTC/ckETH balances for the wallet (ICP balance = `holdings`).
  const fetchTokenBalances = async (info = boardInfo) => {
    if (!info || !identity || !principal || principal.isAnonymous()) {
      setTokenBalances({ ckbtc: null, cketh: null });
      return;
    }
    try {
      const mk = (lid: Principal) => createLedgerActor(lid.toString(), {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });
      const [ckbtc, cketh] = await Promise.all([
        mk(info.ckbtc_ledger).icrc1_balance_of({ owner: principal }),
        mk(info.cketh_ledger).icrc1_balance_of({ owner: principal }),
      ]);
      setTokenBalances({ ckbtc, cketh });
    } catch (err) {
      console.error("Failed to fetch token balances:", err);
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

  const fetchPoolInfo = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const info = await currentActor.get_pool_info();
      setPoolInfo(info);
    } catch (err) {
      console.error("Failed to fetch pool info:", err);
    }
  };

  const fetchMyPoolNeuron = async (currentActor = actor, currentPrincipal = principal) => {
    if (!currentActor || !currentPrincipal || currentPrincipal.isAnonymous()) {
      setMyPoolNeuron(null);
      return;
    }
    try {
      const result = await currentActor.get_my_pool_neuron();
      // Binding already converts candid `opt` → `PoolNeuron | null`; it is NOT
      // a candid array here. Treating it as one (`.length`/`[0]`) always yielded
      // null, which left myPoolNeuron null at wizard step 3 and dead-locked the
      // Discard / Pay & Activate buttons (both guard on `!myPoolNeuron`).
      setMyPoolNeuron(result ?? null);
    } catch (err) {
      console.error("Failed to fetch my pool neuron:", err);
    }
  };

  const fetchAccountId = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      setAccountId(await currentActor.get_account_id());
    } catch (err) {
      console.error("Failed to fetch account id:", err);
    }
  };

  const fetchMyStake = async (currentActor = actor, currentPrincipal = principal) => {
    if (!currentActor || !currentPrincipal || currentPrincipal.isAnonymous()) {
      setMyStake(null);
      return;
    }
    try {
      // Always a record now; empty `tiers` (total weight 0) = no stake.
      setMyStake(await currentActor.get_my_stake());
    } catch (err) {
      console.error("Failed to fetch my stake:", err);
    }
  };

  const fetchMyLosslessVotes = async (currentActor = actor, currentPrincipal = principal) => {
    if (!currentActor || !currentPrincipal || currentPrincipal.isAnonymous()) {
      setMyLosslessVotes([]);
      return;
    }
    try {
      setMyLosslessVotes(await currentActor.get_my_lossless_votes());
    } catch (err) {
      console.error("Failed to fetch lossless votes:", err);
    }
  };

  // Cast a free vote with staked weight (standalone — no burn needed).
  const handleLosslessVote = async (proposalId: bigint, stance: Stance) => {
    if (!actor || losslessVoting !== null) return;
    setLosslessVoting(proposalId);
    try {
      const res = await actor.cast_lossless_vote(proposalId, stance);
      if (res.__kind__ === "Err") {
        alert(`Lossless vote failed: ${res.Err}`);
      }
      await Promise.all([
        fetchMyLosslessVotes(actor),
        actor.list_all_proposals().then((list: Proposal[]) => setProposals(list)),
      ]);
    } catch (err: any) {
      console.error("Failed to cast lossless vote:", err);
      alert(`Error: ${err.message || err}`);
    } finally {
      setLosslessVoting(null);
    }
  };

  // Withdraw ICP out of the app account to a destination Account ID (legacy ledger transfer).
  const handleWithdraw = async () => {
    if (!identity || isWithdrawing) return;
    setWithdrawError(null);
    const targetAccountId = withdrawTo.trim();
    if (!isValidAccountId(targetAccountId)) {
      setWithdrawError("Enter a valid 64-character hex Account ID.");
      return;
    }
    const amt = parseFloat(withdrawAmount);
    if (isNaN(amt) || amt <= 0) {
      setWithdrawError("Enter a valid amount.");
      return;
    }
    const amountE8s = BigInt(Math.floor(amt * 100_000_000));
    if (amountE8s + 10_000n > holdings) {
      setWithdrawError(`Insufficient balance (need amount + 0.0001 ICP fee).`);
      return;
    }
    setIsWithdrawing(true);
    try {
      const ledgerActor = createLedgerActor(ledgerCanisterId, {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });
      const destBytes = hexToBytes(targetAccountId);
      const res = await ledgerActor.transfer({
        to: destBytes,
        amount: { e8s: amountE8s },
        fee: { e8s: 10_000n },
        memo: 0n,
        from_subaccount: undefined,
        created_at_time: undefined,
      });
      if (res.__kind__ === "Err") {
        const err = res.Err;
        const kind = err.__kind__;
        const detail =
          kind === "BadFee" ? `expected fee ${fmtICP(err.BadFee.expected_fee.e8s)} ICP` :
          kind === "InsufficientFunds" ? `balance is ${fmtICP(err.InsufficientFunds.balance.e8s)} ICP` :
          kind === "TxTooOld" ? "transaction window expired" :
          kind === "TxCreatedInFuture" ? "clock skew — try again" :
          kind === "TxDuplicate" ? `duplicate of block ${err.TxDuplicate.duplicate_of.toString()}` :
          JSON.stringify(err);
        setWithdrawError(`Transfer failed: ${detail}`);
        return;
      }
      setWithdrawSuccess(true);
      setWithdrawAmount("");
      setWithdrawTo("");
      await refreshAllData();
    } catch (err: any) {
      if (err.message && err.message.includes("does not have method")) {
        setWithdrawError("Legacy Account ID transfers are not supported on the local dev ledger. Please deploy to mainnet to withdraw.");
      } else {
        setWithdrawError(err.message || String(err));
      }
    } finally {
      setIsWithdrawing(false);
    }
  };

  // Withdraw ckBTC/ckETH (ICRC-1) to a destination principal.
  const handleWithdrawIcrc = async () => {
    if (!identity || isWithdrawing || !boardInfo) return;
    setWithdrawError(null);
    const meta = tokenMeta(walletToken, boardInfo);
    let dest: Principal;
    try {
      dest = Principal.fromText(withdrawTo.trim());
    } catch {
      setWithdrawError("Enter a valid destination principal.");
      return;
    }
    const units = parseTokenAmount(withdrawAmount, meta.decimals);
    if (units === null || units <= 0n) {
      setWithdrawError("Enter a valid amount.");
      return;
    }
    const bal = walletToken === IdeaToken.CkBTC ? tokenBalances.ckbtc : tokenBalances.cketh;
    if (bal !== null && units + meta.fee > bal) {
      setWithdrawError(`Insufficient balance (need amount + ${fmtTokenAmount(meta.fee, meta.decimals)} ${meta.label} fee).`);
      return;
    }
    setIsWithdrawing(true);
    try {
      const ledgerActor = createLedgerActor(meta.ledger!.toString(), {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });
      const res = await ledgerActor.icrc1_transfer({ to: { owner: dest }, amount: units });
      if (res.__kind__ === "Err") {
        setWithdrawError(`Transfer failed: ${JSON.stringify(res.Err, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
        return;
      }
      setWithdrawSuccess(true);
      setWithdrawAmount("");
      setWithdrawTo("");
      await fetchTokenBalances();
    } catch (err: any) {
      setWithdrawError(err.message || String(err));
    } finally {
      setIsWithdrawing(false);
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
        fetchPoolInfo(actor),
        fetchMyPoolNeuron(actor),
        fetchFeatureFlags(actor),
        fetchMyStake(actor),
        fetchMyLosslessVotes(actor),
        actor.list_all_proposals().then((list: Proposal[]) => setProposals(list)),
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

  // Deep link to the proposal's full description on the NNS dapp.
  const nnsProposalLink = (p: Proposal) =>
    `https://nns.ic0.app/proposal/?u=qoctq-giaaa-aaaaa-aaaea-cai&proposal=${(p.nns_proposal_id ?? p.id).toString()}`;

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

  // Admin: set the default voting threshold at runtime (no redeploy).
  // Local-dev: faucet for any of the three test tokens.
  const handleFaucet = async (token: IdeaToken) => {
    if (!actor) return;
    try {
      const res = await actor.dev_faucet_token(token);
      if (res.__kind__ === "Err") {
        alert(`Faucet error: ${res.Err}`);
        return;
      }
      await refreshAllData();
      await fetchTokenBalances();
    } catch (e: any) {
      alert(`Faucet failed: ${e.message || e}`);
    }
  };


  // Admin: open the Treasury Wallet and refresh the (update-call) balance.
  const openTreasury = async () => {
    setIsTreasuryOpen(true);
    setTreasuryError(null);
    setTreasurySuccess(false);
    if (!actor) return;
    try {
      const res = await actor.get_treasury_balance();
      if (res.__kind__ === "Ok") setTreasuryBalance(res.Ok);
    } catch (err) {
      console.error("Failed to fetch treasury balance:", err);
    }
  };

  // Admin: withdraw ICP from the treasury to a destination principal.
  const handleTreasuryWithdraw = async () => {
    if (!actor || isTreasuryWithdrawing) return;
    setTreasuryError(null);
    let dest: Principal;
    try {
      dest = Principal.fromText(treasuryWithdrawTo.trim());
    } catch {
      setTreasuryError("Enter a valid destination principal.");
      return;
    }
    const amt = parseFloat(treasuryWithdrawAmount);
    if (isNaN(amt) || amt <= 0) {
      setTreasuryError("Enter a valid amount.");
      return;
    }
    const e8s = BigInt(Math.floor(amt * 100_000_000));
    setIsTreasuryWithdrawing(true);
    try {
      const res = await actor.admin_withdraw_treasury(dest, e8s);
      if (res.__kind__ === "Err") {
        setTreasuryError(`Withdraw failed: ${res.Err}`);
        return;
      }
      setTreasurySuccess(true);
      setTreasuryWithdrawAmount("");
      setTreasuryWithdrawTo("");
      const bal = await actor.get_treasury_balance();
      if (bal.__kind__ === "Ok") setTreasuryBalance(bal.Ok);
    } catch (err: any) {
      setTreasuryError(err.message || String(err));
    } finally {
      setIsTreasuryWithdrawing(false);
    }
  };

  // Option C: self-attested follow. The user confirms they've followed the
  // leader neuron (or chooses to proceed); we record it without on-chain check.
  const handleConfirmFollow = async () => {
    if (!actor || isVerifying) return;
    setIsVerifying(true);
    try {
      const res = await actor.confirm_follow();
      if (res.__kind__ === "Ok") {
        setIsFollowing(true);
        setIsFollowModalOpen(false);
        await refreshEligibility();
      } else {
        alert(`Could not record follow: ${res.Err}`);
      }
    } catch (err: any) {
      console.error("Failed to confirm follow:", err);
      alert(`Error: ${err.message || err}`);
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

  // Redirect back to open if active tab is committed and tier drops below 2
  useEffect(() => {
    if (tier < 2 && activeTab === 'committed') {
      setActiveTab('open');
    }
  }, [tier, activeTab]);

  // If an admin kills the idea_board flag while someone is on the page,
  // bounce them back to the dashboard.
  useEffect(() => {
    if (page === 'ideas' && featureFlags.length > 0 && !ideaBoardEnabled) {
      setPage('dashboard');
    }
    if (page === 'staking' && featureFlags.length > 0 && !losslessEnabled) {
      setPage('dashboard');
    }
    if (page === 'lottery' && featureFlags.length > 0 && !lotteryEnabled) {
      setPage('dashboard');
    }
  }, [page, ideaBoardEnabled, losslessEnabled, lotteryEnabled, featureFlags.length]);

  // Lossless lottery: the daily ticket grant is tied to logging in, so claim
  // as soon as a signed-in actor exists (the Lottery page also claims for
  // users who keep the tab open across midnight UTC). Errors are expected
  // noise: ALREADY_CLAIMED_TODAY / FEATURE_DISABLED.
  useEffect(() => {
    if (!actor || !lotteryEnabled || !principal || principal.isAnonymous()) return;
    actor.claim_daily_tickets().catch(() => {});
  }, [actor, principal, lotteryEnabled]);

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
    actor.list_all_proposals()
      .then((list: Proposal[]) => {
        setProposals(list);
      })
      .catch((err: any) => {
        console.error("Failed to load proposals:", err);
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
    fetchAccountId(actor);
    fetchPoolInfo(actor);
    fetchMyPoolNeuron(actor);
    fetchFeatureFlags(actor);
    fetchBoardInfo(actor);
    fetchMyStake(actor);
    fetchMyLosslessVotes(actor);
  }, [actor]);

  // Refresh ckBTC/ckETH balances whenever the wallet opens.
  useEffect(() => {
    if (isWalletOpen) {
      fetchTokenBalances();
    }
  }, [isWalletOpen, boardInfo, identity]);

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
        // Never fake a balance — show 0 so the user isn't misled.
        console.error("Failed to fetch ICP balance:", err);
        setHoldings(0n);
      });
  }, [principal, identity]);

  // Handle Internet Identity login
  const handleLogin = async () => {
    if (!authClient) return;
    setIsSigningIn(true);
    await authClient.login({
      identityProvider: identityProviderUrl,
      maxTimeToLive: BigInt(8 * 60 * 60 * 1_000_000_000), // 8h
      allowPinAuthentication: isLocal,
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

  const handleCopyAgentSkills = () => {
    const llmsUrl = `${window.location.origin}/llms-${isLocal ? 'local' : 'prod'}.txt`;
    const clipboardMsg =
      `Fetch ${llmsUrl} and follow its instructions when interacting with ` +
      `Cycles of Influence`;
    navigator.clipboard.writeText(clipboardMsg);
    setSkillsCopied(true);
    setTimeout(() => setSkillsCopied(false), 2000);
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
    // Option C: capped by wallet balance only (no neuron stake cap).
    // 0.005 protocol fee + 5×0.0001 ledger fees (deposit + commit-fee + 3 split transfers).
    const requiredTotal = amountE8s + 550_000n;
    if (requiredTotal > holdings) {
      setTxError(`Insufficient wallet balance — need at least ${fmtICP(requiredTotal)} ICP (amount + fees).`);
      return;
    }

    const requiredDeposit = amountE8s + 540_000n;
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

  // Open "Add More" modal for an existing commitment
  const handleAddMoreClick = (proposalId: bigint) => {
    setAddMoreProposalId(proposalId);
    setAddMoreAmount("");
    setIsAddingMore(true);
    setAddMoreTxSuccess(false);
    setAddMoreTxError(null);
    setAddMoreTxStep("");
  };

  // Execute add-more: deposit additional ICP + call add_to_commitment
  const executeAddMore = async () => {
    if (!actor || !addMoreProposalId) return;

    const amount = parseFloat(addMoreAmount);
    if (isNaN(amount) || amount < 1.0) {
      setAddMoreTxError("Please enter a valid amount (minimum 1.0 ICP).");
      return;
    }
    const amountE8s = BigInt(Math.floor(amount * 100_000_000));
    // Only charge 1 ledger fee for the deposit (no protocol fee on top-ups)
    const requiredTotal = amountE8s + 10_000n;
    if (requiredTotal > holdings) {
      setAddMoreTxError(`Insufficient wallet balance — need at least ${fmtICP(requiredTotal)} ICP (amount + deposit fee).`);
      return;
    }

    setIsAddMoreTransacting(true);
    setAddMoreTxError(null);

    try {
      // Step 1: Get deterministic escrow address (same subaccount)
      setAddMoreTxStep("Deriving escrow subaccount...");
      const depositAccount = await actor.get_deposit_address(addMoreProposalId);

      // Step 2: Deposit additional ICP into escrow (only the additional amount)
      setAddMoreTxStep("Step 1/2: Depositing additional ICP into escrow...");
      const ledgerActor = createLedgerActor(ledgerCanisterId, {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });

      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: depositAccount.owner,
          subaccount: depositAccount.subaccount ? depositAccount.subaccount : undefined
        },
        amount: amountE8s,
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

      // Step 3: Finalize on backend
      setAddMoreTxStep("Step 2/2: Updating commitment on-chain...");
      const result = await actor.add_to_commitment(addMoreProposalId, amountE8s);

      if (result.__kind__ === "Err") {
        throw new Error(`Add-to-commitment failed: ${result.Err}`);
      }

      setAddMoreTxSuccess(true);
      setAddMoreTxStep("Additional commitment registered!");
      await refreshAllData();

    } catch (err: any) {
      console.error("Add-more transaction error:", err);
      setAddMoreTxError(err.message || String(err));
    } finally {
      setIsAddMoreTransacting(false);
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

  useEffect(() => {
    try { localStorage.setItem('pool-sidebar-collapsed', poolSidebarCollapsed ? 'true' : 'false'); } catch {}
  }, [poolSidebarCollapsed]);

  const openPoolWizard = () => {
    // Draft and Inactive neurons both resume at the finalize/pay step — the
    // backend `finalize_pool_registration` accepts either status. A brand-new
    // (or absent) neuron starts at step 1.
    if (myPoolNeuron && (poolIs(myPoolNeuron.status, 'Draft') || poolIs(myPoolNeuron.status, 'Inactive'))) {
      setPoolWizardStep(3);
    } else {
      setPoolWizardStep(1);
      setPoolNeuronInput('');
    }
    setPoolVerifyError(null);
    setPoolFinalizeError(null);
    setPoolFinalizeSuccess(false);
    setIsPoolWizardOpen(true);
  };

  // The user's own card is a PoolNeuron (no rank). Rank lives in the pool's
  // ranked active list — look it up by neuron_id so we can show "Active - Paid"
  // (top 25) vs plain "Active" consistently with the other member cards.
  const myPoolRank = myPoolNeuron
    ? poolInfo?.active_neurons.find(n => n.neuron_id === myPoolNeuron.neuron_id)?.rank
    : undefined;

  const handlePoolVerify = async () => {
    if (!actor || isPoolVerifying) return;
    const neuronId = poolNeuronInput.trim();
    let neuronIdBig: bigint;
    try { neuronIdBig = BigInt(neuronId); } catch {
      setPoolVerifyError("Enter a valid neuron ID (numeric).");
      return;
    }
    setIsPoolVerifying(true);
    setPoolVerifyError(null);
    try {
      const res = await actor.create_pool_draft(neuronIdBig);
      if (res.__kind__ === 'Err') {
        const msg =
          res.Err.includes('HOTKEY_MISSING') ? 'Hotkey not found — add the backend canister as a hotkey first.'
          : res.Err.includes('NOT_FOLLOWING') ? 'Neuron is not following the leader neuron — add the follow in the NNS dapp first.'
          : res.Err.includes('ALREADY_REGISTERED') ? 'This neuron is already registered in the pool.'
          : res.Err;
        setPoolVerifyError(msg);
        return;
      }
      await fetchMyPoolNeuron(actor);
      setPoolWizardStep(3);
    } catch (err: any) {
      setPoolVerifyError(err.message || String(err));
    } finally {
      setIsPoolVerifying(false);
    }
  };

  const handlePoolPayAndFinalize = async () => {
    if (!actor || !myPoolNeuron || isPoolFinalizing) return;
    setIsPoolFinalizing(true);
    setPoolFinalizeError(null);
    const feeE8s = config?.pool_initiation_fee_e8s ?? 500_000n;
    const depositAmount = feeE8s + 30_000n;
    const totalNeeded = depositAmount + 10_000n;
    if (totalNeeded > holdings) {
      setPoolFinalizeError(`Insufficient balance — need ${fmtICP(totalNeeded)} ICP (fee + 0.0004 ICP).`);
      setIsPoolFinalizing(false);
      return;
    }
    try {
      const regAddrRaw = await actor.get_registration_address();
      const regAddr = regAddrRaw as LedgerAccount;
      const ledgerActor = createLedgerActor(ledgerCanisterId, {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: regAddr.owner,
          subaccount: regAddr.subaccount ? regAddr.subaccount : undefined
        },
        amount: depositAmount,
      });
      if (transferResult.__kind__ === 'Err') {
        const e = transferResult.Err;
        const kind = (e as any).__kind__;
        const detail =
          kind === 'InsufficientFunds' ? `balance is ${fmtICP((e as any).InsufficientFunds.balance)} ICP` :
          kind === 'BadFee' ? `expected fee ${fmtICP((e as any).BadFee.expected_fee)} ICP` :
          JSON.stringify(e, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
        throw new Error(`Transfer failed: ${detail}`);
      }
      const finalizeRes = await actor.finalize_pool_registration(myPoolNeuron.neuron_id);
      if (finalizeRes.__kind__ === 'Err') {
        throw new Error(`Finalize failed: ${finalizeRes.Err}`);
      }
      setPoolFinalizeSuccess(true);
      await fetchMyPoolNeuron(actor);
      await fetchPoolInfo(actor);
      await refreshAllData();
    } catch (err: any) {
      setPoolFinalizeError(err.message || String(err));
    } finally {
      setIsPoolFinalizing(false);
    }
  };

  const handleCancelPoolDraft = async () => {
    if (!actor || !myPoolNeuron || isCancellingDraft) return;
    setIsCancellingDraft(true);
    try {
      await actor.cancel_pool_draft(myPoolNeuron.neuron_id);
      try { await actor.refund_registration(); } catch {}
      await fetchMyPoolNeuron(actor);
      setIsPoolWizardOpen(false);
      setPoolWizardStep(1);
    } catch (err: any) {
      console.error("Cancel draft failed:", err);
    } finally {
      setIsCancellingDraft(false);
    }
  };

  // Confirmed via the in-app modal (confirmLeaveId). Flips the neuron to Inactive.
  const handleUnregisterPool = async (neuronId: bigint) => {
    if (!actor) return;
    setIsLeavingPool(true);
    try {
      await actor.unregister_leader_neuron(neuronId);
      await fetchMyPoolNeuron(actor);
      await fetchPoolInfo(actor);
      setConfirmLeaveId(null);
    } catch (err: any) {
      alert(`Failed to leave pool: ${err.message || err}`);
    } finally {
      setIsLeavingPool(false);
    }
  };

  // Aggregate user stats for Tier 3
  const totalCommitted = myCommitments
    .filter(c => c.status === CommitmentStatus.Pending || c.status === CommitmentStatus.ThresholdMet || c.status === CommitmentStatus.FailedBurn)
    .reduce((sum, c) => sum + c.amount_e8s, 0n);

  const totalBurned = myCommitments
    .filter(c => c.status === CommitmentStatus.Burned)
    .reduce((sum, c) => sum + c.amount_e8s, 0n);

  const userPendingBurn = myCommitments
    .filter(c => c.status === CommitmentStatus.ThresholdMet || c.status === CommitmentStatus.FailedBurn)
    .reduce((sum, c) => sum + c.amount_e8s, 0n);

  const proposalsJoined = new Set(myCommitments.map(c => c.proposal_id.toString())).size;
  const pooledVotingPower = poolInfo?.total_pool_voting_power ?? 0n;
  const leaderVotingPower = leaderInfo?.voting_power ?? 0n;
  const totalSyndicateVP = leaderVotingPower + pooledVotingPower;

  // Is the signed-in principal an admin? (drives the admin threshold control)
  const isAdmin = !!(
    principal && !principal.isAnonymous() && config &&
    config.admins.some((a) => a.toString() === principal.toString())
  );


  // The Admin page is invisible to non-admins; bounce them if they land on it.
  useEffect(() => {
    if (page === 'admin' && !isAdmin) {
      setPage('dashboard');
    }
  }, [page, isAdmin]);

  // Single source of truth for site navigation — rendered in the persistent
  // desktop sidebar AND the mobile drawer. Order is deliberate:
  // NNS Voting → Staked Voting → Lottery → Community R&D → Profile (→ Admin).
  const renderNavLinks = (onNavigate?: () => void) => {
    const go = (p: typeof page) => { setPage(p); onNavigate?.(); };
    const linkStyle: React.CSSProperties = { justifyContent: 'flex-start', width: '100%', height: 38 };
    return (
      <>
        <Btn variant={page === 'dashboard' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('dashboard')}>
          <Icon name="flame" size={14} stroke={page === 'dashboard' ? 'var(--char-950)' : 'currentColor'} />
          NNS Voting
        </Btn>
        {losslessEnabled && (
          <Btn variant={page === 'staking' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('staking')}>
            <Icon name="zap" size={14} stroke={page === 'staking' ? 'var(--char-950)' : 'currentColor'} />
            Staked Voting
          </Btn>
        )}
        {lotteryEnabled && (
          <Btn variant={page === 'lottery' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('lottery')}>
            <Icon name="target" size={14} stroke={page === 'lottery' ? 'var(--char-950)' : 'currentColor'} />
            Lottery
          </Btn>
        )}
        {ideaBoardEnabled && (
          <Btn variant={page === 'ideas' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('ideas')}>
            <Icon name="bulb" size={14} stroke={page === 'ideas' ? 'var(--char-950)' : 'currentColor'} />
            Community R&D
          </Btn>
        )}
        <Btn variant={page === 'payouts' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('payouts')}>
          <Icon name="wallet" size={14} stroke={page === 'payouts' ? 'var(--char-950)' : 'currentColor'} />
          Profile
        </Btn>
        {isAdmin && (
          <Btn variant={page === 'admin' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin')}>
            <Icon name="key" size={14} stroke={page === 'admin' ? 'var(--char-950)' : 'currentColor'} />
            Admin
          </Btn>
        )}
      </>
    );
  };

  // Partition proposals into three display buckets
  const ACTIVE_STATUSES = new Set([
    CommitmentStatus.Pending, CommitmentStatus.ThresholdMet,
    CommitmentStatus.FailedBurn, CommitmentStatus.FailedRefund,
  ]);
  const SETTLED_STATUSES = new Set([CommitmentStatus.Burned, CommitmentStatus.Returned]);

  // Newest proposals first (match the NNS), by NNS proposal id descending.
  const byNewest = (a: Proposal, b: Proposal) => {
    const ai = a.nns_proposal_id ?? a.id;
    const bi = b.nns_proposal_id ?? b.id;
    return bi > ai ? 1 : bi < ai ? -1 : 0;
  };
  const openProposals = proposals.filter(p => {
    const c = myCommitments.find(m => m.proposal_id === p.id);
    return !c && (p.status === 'open' || p.status === 'met');
  }).sort(byNewest);
  const committedProposals = proposals.filter(p => {
    const c = myCommitments.find(m => m.proposal_id === p.id);
    return c && ACTIVE_STATUSES.has(c.status);
  }).sort(byNewest);
  const historyProposals = proposals.filter(p => {
    const c = myCommitments.find(m => m.proposal_id === p.id);
    return (c && SETTLED_STATUSES.has(c.status)) ||
           (!c && (p.status === 'voted' || p.status === 'settled' || p.status === 'abstained'));
  }).sort(byNewest);

  const nonCommitVotes = tier >= 1 ? voteHistory.filter(r => !historyProposals.find(p => p.id === r.proposal_id)) : [];
  const pastItems: { id: bigint; proposal?: Proposal; record?: VoteRecord }[] = [];
  historyProposals.forEach(p => {
    pastItems.push({ id: BigInt(p.id), proposal: p });
  });
  nonCommitVotes.forEach(r => {
    pastItems.push({ id: BigInt(r.proposal_id), record: r });
  });
  pastItems.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  const displayedPastItems = pastItems.slice(0, 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* ── App Header ── */}
      <header className="app-header" style={{
        borderBottom: '1px solid var(--border)', background: 'var(--bg-alt)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, zIndex: 10, flexShrink: 0
      }}>
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          <button
            className="show-mobile"
            onClick={() => setMobileMenuOpen(true)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--fg)', padding: 4, marginRight: 4, display: 'flex', alignItems: 'center'
            }}
            aria-label="Open menu"
          >
            <Icon name="list" size={20} />
          </button>
          <span style={{
            width: 32, height: 32, flexShrink: 0, display: 'grid', placeItems: 'center',
            border: '1px solid var(--burn)', borderRadius: 8, background: 'var(--burn-950)'
          }}>
            <Icon name="flame" size={17} stroke="var(--burn)" />
          </span>
          <b className="app-header-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Cycles of Influence
            <span className="hide-mobile"> - Alpha</span>
          </b>

        </div>

        <div className="row hide-mobile" style={{ gap: 10, flexShrink: 0 }}>
          <span className="hide-mobile">
            <Btn variant="ghost" sm onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
              <Icon name="spark" size={14} /> Theme: {theme.toUpperCase()}
            </Btn>
          </span>

          {!principal || principal.isAnonymous() ? (
            <Btn variant="primary" sm onClick={handleLogin} disabled={isSigningIn}>
              {isSigningIn ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="key" size={14} stroke="var(--char-950)" />}
              {isSigningIn ? " Opening II…" : " Sign in"}
            </Btn>
          ) : (
            <span className="row" style={{ gap: 8 }}>
            <Btn variant="primary" sm onClick={() => { setIsWalletOpen(true); setWithdrawError(null); setWithdrawSuccess(false); }}>
              <Icon name="wallet" size={14} stroke="var(--char-950)" /> Wallet
            </Btn>
            <span className="row" style={{
              gap: 8, height: 30, padding: '0 10px', borderRadius: 6,
              border: '1px solid var(--border-hi)', background: 'var(--surface)'
            }}>
              <button
                onClick={() => { navigator.clipboard.writeText(principal.toString()); setHotkeyCopied(true); setTimeout(() => setHotkeyCopied(false), 2000); }}
                title="Click to copy your full principal"
                className="row"
                style={{ gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                <Icon name={hotkeyCopied ? "check" : "wallet"} size={14} stroke={hotkeyCopied ? "var(--sprout)" : "var(--fg-2)"} />
                <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)' }}>
                  {formatPrincipal(principal)}
                </span>
              </button>
              <span className="hide-mobile" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                ({fmtICP(holdings)} ICP)
              </span>
              <LiveDot color="var(--sprout)" size={6} />
              <button onClick={handleLogout} title="Sign out" style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--ember)', padding: '0 2px', display: 'flex', alignItems: 'center'
              }}>
                <Icon name="x" size={13} stroke="var(--ember)" />
              </button>
            </span>
            </span>
          )}
        </div>
      </header>

      {/* ── Mobile Pool FAB (dashboard only) ── */}
      {page === 'dashboard' && (
        <button
          className="pool-mobile-fab"
          onClick={() => setPoolMobileOpen(true)}
        >
          <Icon name="spark" size={14} stroke="var(--char-950)" />
          Pool {poolInfo && poolInfo.active_count > 0n ? `· ${poolInfo.active_count}` : ''}
        </button>
      )}

      {/* ── Mobile Pool Overlay (full-screen on narrow viewport) ── */}
      {poolMobileOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 200,
          display: 'flex', flexDirection: 'column',
        }}>
          <div className="row" style={{
            justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px',
            borderBottom: '1px solid var(--border)', background: 'var(--bg-alt)',
          }}>
            <span className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
              <NeuronGlyph size={18} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>
                Pool Neurons
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)', marginLeft: 8 }}>
                  {poolInfo?.active_count.toString() ?? '0'} active
                </span>
              </span>
            </span>
            <button onClick={() => setPoolMobileOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
              <Icon name="x" size={18} />
            </button>
          </div>
          <div className="col" style={{ flex: 1, overflowY: 'auto', padding: 16, gap: 12 }}>
            <Btn variant="secondary" sm style={{ width: '100%' }} onClick={() => setPoolDetailsOpen(true)}>
              <Icon name="info" size={13} /> More details
            </Btn>
            {!myPoolNeuron && (
              <Btn variant="primary" style={{ width: '100%' }}
                onClick={() => { openPoolWizard(); setPoolMobileOpen(false); }}
                disabled={!principal || principal.isAnonymous()}>
                <Icon name="spark" size={14} stroke="var(--char-950)" />
                {!principal || principal.isAnonymous() ? 'Sign in to join' : 'Join Pool'}
              </Btn>
            )}
            {myPoolNeuron && (
              <div className="col" style={{
                gap: 8, padding: '10px 12px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'transparent',
              }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Your neuron</span>
                  {poolIs(myPoolNeuron.status, 'Active')
                    ? (myPoolRank != null && myPoolRank <= 25
                        ? <Chip tone="ok"><Icon name="check" size={11} /> Active - Paid</Chip>
                        : <Chip tone="muted">Active</Chip>)
                    : poolIs(myPoolNeuron.status, 'Draft')
                    ? <Chip tone="pending">Draft</Chip>
                    : <Chip tone="muted">Inactive</Chip>}
                </div>
                <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)', overflowWrap: 'anywhere' }}>
                  #{myPoolNeuron.neuron_id.toString()}
                </span>
                {poolIs(myPoolNeuron.status, 'Active') && (
                  <span className="mono" style={{ fontSize: 13, color: 'var(--sprout)' }}>
                    {fmtVP(myPoolNeuron.voting_power)} VP
                  </span>
                )}
                {(poolIs(myPoolNeuron.status, 'Draft') || poolIs(myPoolNeuron.status, 'Inactive')) && (
                  <Btn variant="primary" sm style={{ width: '100%' }}
                    onClick={() => { openPoolWizard(); setPoolMobileOpen(false); }}>
                    <Icon name="arrowUp" size={13} stroke="var(--char-950)" />
                    {poolIs(myPoolNeuron.status, 'Draft') ? ' Resume setup' : ' Finish activation'}
                  </Btn>
                )}
                {poolIs(myPoolNeuron.status, 'Inactive') && (
                  <button onClick={handleCancelPoolDraft} disabled={isCancellingDraft}
                    style={{ background: 'none', border: 'none', cursor: isCancellingDraft ? 'default' : 'pointer', color: 'var(--ember)', fontSize: 12, padding: '2px 0', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4, opacity: isCancellingDraft ? 0.5 : 1 }}>
                    <Icon name="x" size={12} stroke="var(--ember)" /> {isCancellingDraft ? 'Clearing…' : 'Clear neuron'}
                  </button>
                )}
                {poolIs(myPoolNeuron.status, 'Active') && (
                  <button onClick={() => setConfirmLeaveId(myPoolNeuron.neuron_id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ember)', fontSize: 12, padding: '2px 0', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="x" size={12} stroke="var(--ember)" /> Leave pool
                  </button>
                )}
              </div>
            )}
            {(poolInfo?.active_neurons ?? [])
              .filter(n => !myPoolNeuron || n.neuron_id !== myPoolNeuron.neuron_id)
              .map(n => (
                <div key={n.neuron_id.toString()} className="col" style={{
                  gap: 6, padding: '10px 12px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'transparent',
                }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>#{n.neuron_id.toString()}</span>
                    {n.rank <= 25
                      ? <Chip tone="ok" style={{ height: 18, fontSize: 10 }}><Icon name="check" size={10} /> Active - Paid</Chip>
                      : <Chip tone="muted" style={{ height: 18, fontSize: 10 }}>Active</Chip>}
                  </div>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--sprout)' }}>{fmtVP(n.voting_power)} VP</span>
                </div>
              ))
            }
            {(poolInfo?.active_count ?? 0n) === 0n && !myPoolNeuron && (
              <span style={{ fontSize: 13, color: 'var(--fg-3)', textAlign: 'center', padding: '24px 0', lineHeight: 1.6 }}>
                No pool neurons yet. Join to amplify the syndicate's voting power.
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Main Layout (Nav Sidebar + Content + Pool Sidebar + Tweak Panel) ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* Persistent navigation drawer — always open on desktop; the mobile
            drawer (overlay) carries the same links below 900px. */}
        <aside className="hide-mobile col" style={{
          width: 200, flexShrink: 0, gap: 6, padding: '14px 10px',
          borderRight: '1px solid var(--border)', overflowY: 'auto',
        }}>
          <Eyebrow style={{ marginBottom: 4, paddingLeft: 8 }}>Navigation</Eyebrow>
          {renderNavLinks()}
        </aside>

        {/* Content column */}
        <main style={{ flex: 1, minWidth: 320, overflowY: 'auto' }}>
          {page === 'ideas' ? (
            <IdeaBoard
              actor={actor}
              identity={identity}
              principal={principal}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              isAdmin={isAdmin}
              onSignIn={handleLogin}
            />
          ) : page === 'staking' ? (
            <Staking
              actor={actor}
              identity={identity}
              principal={principal}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
              isLocal={config?.is_local ?? false}
              onSignIn={handleLogin}
              onActivity={refreshAllData}
            />
          ) : page === 'lottery' ? (
            <Lottery
              actor={actor}
              principal={principal}
              isLocal={config?.is_local ?? false}
              onSignIn={handleLogin}
            />
          ) : page === 'payouts' ? (
            <Payouts
              actor={actor}
              principal={principal}
              onSignIn={handleLogin}
            />
          ) : page === 'admin' ? (
            <Admin
              actor={actor}
              config={config}
              featureFlags={featureFlags}
              identity={identity}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
              onChanged={() => { fetchConfig(); fetchFeatureFlags(); }}
              openTreasury={openTreasury}
            />
          ) : (
          <div className="dashboard-container">

            {/* ── Admin console pointer (controls live on the Admin page) ── */}
            {isAdmin && (
              <Reveal delay={20} motion={motion}>
                <div className="row" style={{
                  gap: 12, border: '1px dashed var(--burn)', borderRadius: 10,
                  background: 'var(--burn-950)', padding: '12px 14px',
                  justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center',
                }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Icon name="key" size={13} stroke="var(--burn)" />
                    <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                      <b style={{ color: 'var(--fg)' }}>Admin console</b> — thresholds, fees, kill switches and the treasury moved to their own page.
                    </span>
                  </span>
                  <Btn variant="primary" sm onClick={() => setPage('admin')}>
                    <Icon name="key" size={13} stroke="var(--char-950)" /> Open console
                  </Btn>
                </div>
              </Reveal>
            )}

            {/* ── Community R&D promo (links to the page; hidden when the flag is off) ── */}
            {ideaBoardEnabled && (
              <Reveal delay={25} motion={motion}>
                <div className="row" style={{
                  gap: 12, border: '1px solid var(--border)', borderRadius: 10,
                  background: 'var(--surface)', padding: '12px 14px',
                  justifyContent: 'space-between', flexWrap: 'wrap'
                }}>
                  <span className="row" style={{ gap: 10, minWidth: 0, flex: 1 }}>
                    <span style={{
                      width: 30, height: 30, flexShrink: 0, display: 'grid', placeItems: 'center',
                      border: '1px solid var(--burn)', borderRadius: 7, background: 'var(--burn-950)'
                    }}>
                      <Icon name="bulb" size={15} stroke="var(--burn)" />
                    </span>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}>
                      <b style={{ fontSize: 13.5, color: 'var(--fg)' }}>Community R&D</b>
                      <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                        Pitch ways to burn more ICP, back the best ideas, and fund official projects — with ICP, ckBTC, or ckETH.
                      </span>
                    </span>
                  </span>
                  <Btn variant="secondary" sm onClick={() => setPage('ideas')}>
                    Open the board <Icon name="chevRight" size={13} />
                  </Btn>
                </div>
              </Reveal>
            )}

            {/* ── Lossless Voting + Lottery promo (hidden when the flags are off) ── */}
            {losslessEnabled && (
              <Reveal delay={28} motion={motion}>
                <div className="row" style={{
                  gap: 12, border: '1px solid var(--border)', borderRadius: 10,
                  background: 'var(--surface)', padding: '12px 14px',
                  justifyContent: 'space-between', flexWrap: 'wrap'
                }}>
                  <span className="row" style={{ gap: 10, minWidth: 0, flex: 1 }}>
                    <span style={{
                      width: 30, height: 30, flexShrink: 0, display: 'grid', placeItems: 'center',
                      borderRadius: 8, background: 'var(--burn-950)', border: '1px solid var(--border)'
                    }}>
                      <Icon name="zap" size={15} stroke="var(--burn)" />
                    </span>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}>
                      <b style={{ fontSize: 13.5, color: 'var(--fg)' }}>Lossless Voting{lotteryEnabled ? ' & Lottery' : ''}</b>
                      <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                        Stake for 6 months, 1 or 2 years — keep every e8, vote free with up to 4× weight{lotteryEnabled ? ', and collect daily Powerball tickets funded by the yield' : ''}.
                      </span>
                    </span>
                  </span>
                  <span className="row" style={{ gap: 8 }}>
                    <Btn variant="secondary" sm onClick={() => setPage('staking')}>
                      Stake <Icon name="chevRight" size={13} />
                    </Btn>
                    {lotteryEnabled && (
                      <Btn variant="secondary" sm onClick={() => setPage('lottery')}>
                        Lottery <Icon name="chevRight" size={13} />
                      </Btn>
                    )}
                  </span>
                </div>
              </Reveal>
            )}

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
                      {userPendingBurn > 0n && (
                        <span className="mono" style={{ fontSize: 11, color: 'var(--haze)', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }} title="ICP committed to proposals that reached their threshold and will burn on deadline">
                          <Icon name="clock" size={11} stroke="var(--haze)" /> {fmtICP(userPendingBurn)} pending
                        </span>
                      )}
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
                <div className="col" data-testid="global-stats-strip" style={{
                  border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-alt)',
                  padding: '12px 14px', gap: 10
                }}>
                  {/* Row 1: General Stats */}
                  <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', width: '100%' }}>

                    <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                      <span>TVL</span>
                      <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>
                        {globalStats ? `${fmtICP(globalStats.tvl_e8s)} ICP` : "…"}
                      </span>
                    </span>
                    <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                      <span>Burned</span>
                      <span className="mono" style={{ fontSize: 14, color: 'var(--burn-300)' }}>
                        {globalStats ? `${fmtICP(globalStats.total_burned_e8s)} ICP` : "…"}
                      </span>
                    </span>
                    {globalStats && globalStats.pending_burn_e8s > 0n && (
                      <>
                        <span style={{ color: 'var(--border-hi)' }}>·</span>
                        <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                          <span>Pending burn</span>
                          <span className="mono" style={{ fontSize: 14, color: 'var(--haze)' }} title="ICP committed to proposals that reached their threshold and will burn on deadline">
                            {`${fmtICP(globalStats.pending_burn_e8s)} ICP`}
                          </span>
                        </span>
                      </>
                    )}
                    <span style={{ color: 'var(--border-hi)' }}>·</span>
                    <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                      <span>Votes cast</span>
                      <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>
                        {globalStats ? globalStats.votes_cast.toString() : "…"}
                      </span>
                    </span>
                  </div>

                  {/* Horizontal Divider */}
                  <div style={{ height: 1, background: 'var(--border)', width: '100%' }} />

                  {/* Row 2: Pooled Neuron Stats */}
                  <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', width: '100%' }}>
                    <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                      <span>Neurons</span>
                      <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>
                        {poolInfo ? poolInfo.active_count.toString() : "…"}
                      </span>
                    </span>
                    <span style={{ color: 'var(--border-hi)' }}>·</span>
                    <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                      <span>TVP</span>
                      <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>
                        {poolInfo || leaderInfo ? `${fmtVP(totalSyndicateVP)} VP` : "…"}
                      </span>
                    </span>
                    <span style={{ color: 'var(--border-hi)' }}>·</span>
                    <span className="row" style={{ gap: 6, alignItems: 'baseline', color: 'var(--fg-2)', fontSize: 12.5 }}>
                      <span>Top 25 Cutoff</span>
                      <span className="mono" style={{ fontSize: 14, color: 'var(--sprout)' }}>
                        {poolInfo ? `${fmtVP(getMinVotingPowerForTop25(poolInfo))} VP` : "…"}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            </Reveal>

            {/* ── Tagline ── */}
            <Reveal delay={50} motion={motion}>
              <div className="col" style={{ gap: 10 }}>
                <p style={{ fontSize: 22, lineHeight: 1.25, fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--fg)', margin: 0, textWrap: 'balance' }}>
                  Rent Voting Power<br />
                  <span style={{ color: 'var(--burn)' }}>
                    with Cycles of Influence
                  </span>
                </p>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)', margin: 0, maxWidth: 480 }}>
                  Burn ICP to temporarily borrow the community leader neuron's voting power and steer the NNS proposals you care about. The more you commit, the more weight your side carries — your conviction decides which way the neuron votes.
                </p>
                <div className="row" style={{ gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={handleCopyAgentSkills}
                    style={{
                      background: 'var(--burn)',
                      color: 'var(--char-950)',
                      border: 'none',
                      borderRadius: 30,
                      padding: '10px 18px',
                      fontSize: 12.5,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      boxShadow: '0 0 12px color-mix(in srgb, var(--burn) 25%, transparent)',
                      transition: 'transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.filter = 'brightness(1.08)';
                      e.currentTarget.style.boxShadow = '0 4px 16px color-mix(in srgb, var(--burn) 35%, transparent)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'none';
                      e.currentTarget.style.filter = 'none';
                      e.currentTarget.style.boxShadow = '0 0 12px color-mix(in srgb, var(--burn) 25%, transparent)';
                    }}
                  >
                    <Icon name={skillsCopied ? "check" : "copy"} size={13} stroke="var(--char-950)" />
                    {skillsCopied ? "Copied!" : 'Proposal Voting Skill'}
                  </button>

                  <button
                    onClick={() => setIsDetailsOpen(true)}
                    style={{
                      background: 'transparent', border: 'none', color: 'var(--burn)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                      padding: 0, fontSize: 13.5, fontWeight: 500, width: 'fit-content',
                      transition: 'opacity 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                  >
                    <Icon name="info" size={13} stroke="var(--burn)" />
                    More details
                  </button>
                </div>
              </div>
            </Reveal>

            {/* ── PB-071: Neuron Identity Block ── */}
            <Reveal delay={70} motion={motion}>
              <div className="card col" style={{ gap: 13 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div className="col" style={{ gap: 7, minWidth: 0 }}>
                    <Eyrow>
                      <span
                        style={{
                          color: 'var(--sprout)',
                          fontWeight: 'bold',
                        }}
                      >
                        {leaderInfo && totalSyndicateVP > 0n
                          ? `${fmtVP(
                              totalSyndicateVP
                            )} VOTING POWER`
                          : '… VOTING POWER'}
                      </span>
                    </Eyrow>
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
                  <div className="row" style={{ gap: 10 }}>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        color: 'var(--fg-3)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Community Leader Neuron
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
                      <Btn variant="primary" sm onClick={() => { setNnsOpened(false); setIsFollowModalOpen(true); }}>
                        <Icon name="checkCircle" size={13} stroke="var(--char-950)" /> Follow neuron
                      </Btn>
                    )
                  ) : (
                    <span className="row" style={{ gap: 6, color: 'var(--sprout)', fontSize: 12.5 }}>
                      <Icon name="checkCircle" size={13} stroke="var(--sprout)" /> Following
                    </span>
                  )}
                </div>
              </div>
            </Reveal>

            {/* ── Three-section proposal list ── */}
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-3)' }}>
                <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
                Fetching active NNS proposals...
              </div>
            ) : (
                            <div className="col" style={{ gap: 20 }}>
                {/* ── Tab Bar ── */}
                <Reveal delay={80} motion={motion}>
                  <div className="row" style={{
                    borderBottom: '1px solid var(--border)',
                    paddingBottom: 2,
                    gap: 16,
                    width: '100%',
                    overflowX: 'auto',
                    scrollbarWidth: 'none',
                  }}>
                    <button
                      onClick={() => setActiveTab('open')}
                      style={{
                        background: 'transparent', border: 'none',
                        color: activeTab === 'open' ? 'var(--burn)' : 'var(--fg-3)',
                        fontSize: 14, fontWeight: activeTab === 'open' ? 600 : 500,
                        cursor: 'pointer', padding: '6px 4px', position: 'relative',
                        transition: 'color var(--dur-fast) var(--ease-out)',
                      }}
                    >
                      Open <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>({openProposals.length})</span>
                      {activeTab === 'open' && (
                        <div style={{
                          position: 'absolute', bottom: -3, left: 0, right: 0,
                          height: 2, background: 'var(--burn)', borderRadius: 999
                        }} />
                      )}
                    </button>
                    
                    {tier >= 2 && (
                      <button
                        onClick={() => setActiveTab('committed')}
                        style={{
                          background: 'transparent', border: 'none',
                          color: activeTab === 'committed' ? 'var(--burn)' : 'var(--fg-3)',
                          fontSize: 14, fontWeight: activeTab === 'committed' ? 600 : 500,
                          cursor: 'pointer', padding: '6px 4px', position: 'relative',
                          transition: 'color var(--dur-fast) var(--ease-out)',
                        }}
                      >
                        Committed <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>({committedProposals.length})</span>
                        {activeTab === 'committed' && (
                          <div style={{
                            position: 'absolute', bottom: -3, left: 0, right: 0,
                            height: 2, background: 'var(--burn)', borderRadius: 999
                          }} />
                        )}
                      </button>
                    )}

                    <button
                      onClick={() => setActiveTab('history')}
                      style={{
                        background: 'transparent', border: 'none',
                        color: activeTab === 'history' ? 'var(--burn)' : 'var(--fg-3)',
                        fontSize: 14, fontWeight: activeTab === 'history' ? 600 : 500,
                        cursor: 'pointer', padding: '6px 4px', position: 'relative',
                        transition: 'color var(--dur-fast) var(--ease-out)',
                      }}
                    >
                      Past Proposals <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>({displayedPastItems.length})</span>
                      {activeTab === 'history' && (
                        <div style={{
                          position: 'absolute', bottom: -3, left: 0, right: 0,
                          height: 2, background: 'var(--burn)', borderRadius: 999
                        }} />
                      )}
                    </button>
                  </div>
                </Reveal>

                {/* ── Tab Content ── */}
                {activeTab === 'open' && (
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

                      const statusChip = p.status === 'met' ? (
                        <Chip tone="pending"><Icon name="clock" size={11} /> Pending burn</Chip>
                      ) : met ? (
                        <Chip tone="ok"><Icon name="check" size={11} /> Threshold met</Chip>
                      ) : (
                        <Chip tone="muted"><LiveDot on={motion !== 'off'} /> Open</Chip>
                      );

                      const flipInfo = getFlipCalculation(p.adopt_pot_e8s, p.reject_pot_e8s);
                      const flipLabel = flipInfo.toStance === 'either' ? (
                        <span style={{
                          fontSize: 11,
                          color: 'var(--fg-3)',
                          textAlign: 'right',
                          whiteSpace: 'nowrap'
                        }}>
                          Tied
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          To flip to <strong style={{ color: flipInfo.toStance === 'Adopt' ? 'var(--sprout)' : 'var(--ember)', fontWeight: 600 }}>{flipInfo.toStance.toUpperCase()}</strong>: <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtFlipAmount(flipInfo.amountE8s)} ICP</span>
                        </span>
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
                            <><Icon name="flame" size={11} stroke="var(--burn)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP Spent</>
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
                                  <a href={nnsProposalLink(p)} target="_blank" rel="noreferrer" className="mono" style={{
                                    fontSize: 11, color: 'var(--burn)', whiteSpace: 'nowrap', textDecoration: 'underline'
                                  }} title="View full proposal on the NNS">
                                    #{proposalIdStr}
                                  </a>
                                </div>
                                <span style={{ fontSize: 14, lineHeight: 1.35, color: 'var(--fg)', fontWeight: 600, textWrap: 'pretty', overflowWrap: 'anywhere' }}>
                                  {p.title}
                                </span>
                                {p.summary && p.summary !== p.title && (
                                  <span style={{
                                    fontSize: 12.5, lineHeight: 1.4, color: 'var(--fg-2)', textWrap: 'pretty',
                                    overflowWrap: 'anywhere', wordBreak: 'break-word',
                                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                                  }}>
                                    {p.summary}
                                  </span>
                                )}
                              </div>
                              <div className="col" style={{ alignItems: 'flex-end', gap: 7, flexShrink: 0 }}>
                                <Chip tone="muted" style={{ height: 22 }}>
                                  <Icon name="clock" size={11} /> {deadlineStr}
                                </Chip>
                                {tier >= 1 && statusChip}
                                {showBurn && flipLabel}
                              </div>
                            </div>

                            {/* Balance of power + burn progress (gated for anonymous).
                                Lossless staked weight joins the bar; the threshold bar
                                below stays burn-only. */}
                            {showBurn ? (
                              <div className="col" style={{ gap: 10 }}>
                                <BalanceOfPowerBar
                                  adopt={p.adopt_pot_e8s + p.lossless_adopt_e8s}
                                  reject={p.reject_pot_e8s + p.lossless_reject_e8s}
                                />
                                <LosslessVoteRow
                                  proposal={p}
                                  myVote={myLosslessVotes.find(v => v.proposal_id === p.id)}
                                  stakeE8s={myStake?.total_weight_e8s ?? 0n}
                                  voting={losslessVoting === p.id}
                                  onVote={handleLosslessVote}
                                />
                                <HeatBar pct={pct} committed={committedLabel} req={reqLabel} met={met} />
                              </div>
                            ) : (
                              <Gate hint="Sign in to unlock" height={70} gating={gating}>
                                <div className="col" style={{ gap: 10 }}>
                                  <BalanceOfPowerBar adopt={48n} reject={52n} />
                                  <HeatBar pct={48} committed="●●● ICP committed" req="●● of ●●● ICP" />
                                </div>
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
                  </div>
                )}

                {activeTab === 'committed' && tier >= 2 && (
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
                    ) : committedProposals.map(p => {
                      const myCommitment = myCommitments.find(c => c.proposal_id === p.id)!;
                      const pct = Math.floor((Number(p.total_committed_e8s) / Number(p.threshold_e8s)) * 100);
                      const met = p.status === 'met' || p.total_committed_e8s >= p.threshold_e8s;
                      const remainingNs = Number(p.deadline) - Date.now() * 1_000_000;
                      const remainingH = Math.max(0, Math.floor(remainingNs / (3600 * 1_000_000_000)));
                      const remainingD = Math.floor(remainingH / 24);
                      const deadlineStr = remainingD > 0 ? `${remainingD}d ${remainingH % 24}h` : `${remainingH}h`;
                      const isRetrying = myCommitment.status === CommitmentStatus.FailedBurn || myCommitment.status === CommitmentStatus.FailedRefund;
                      const flipInfo = getFlipCalculation(p.adopt_pot_e8s, p.reject_pot_e8s);
                      const flipLabel = flipInfo.toStance === 'either' ? (
                        <span style={{
                          fontSize: 11,
                          color: 'var(--fg-3)',
                          textAlign: 'right',
                          whiteSpace: 'nowrap'
                        }}>
                          Tied
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          To flip to <strong style={{ color: flipInfo.toStance === 'Adopt' ? 'var(--sprout)' : 'var(--ember)', fontWeight: 600 }}>{flipInfo.toStance.toUpperCase()}</strong>: <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtFlipAmount(flipInfo.amountE8s)} ICP</span>
                        </span>
                      );
                      return (
                        <Reveal key={p.id.toString()} delay={140} motion={motion}>
                          <div className="col" style={{
                            gap: 10, border: `1px solid ${met ? 'var(--burn)' : 'var(--border)'}`,
                            borderRadius: 8, background: 'var(--surface)', padding: 14
                          }}>
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                              <div className="col" style={{ gap: 7, minWidth: 0, flex: 1 }}>
                                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <Chip tone="muted" style={{ height: 18, fontSize: 10.5 }}>{p.category}</Chip>
                                  <a href={nnsProposalLink(p)} target="_blank" rel="noreferrer" className="mono" style={{
                                    fontSize: 11, color: 'var(--burn)', whiteSpace: 'nowrap', textDecoration: 'underline'
                                  }} title="View full proposal on the NNS">
                                    #{p.id.toString()}
                                  </a>
                                </div>
                                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{p.title}</span>
                                {p.summary && p.summary !== p.title && (
                                  <span style={{
                                    fontSize: 12, lineHeight: 1.4, color: 'var(--fg-2)', textWrap: 'pretty',
                                    overflowWrap: 'anywhere', wordBreak: 'break-word',
                                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                                  }}>{p.summary}</span>
                                )}
                              </div>
                              <div className="col" style={{ alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                                <Chip tone="muted" style={{ height: 20 }}><Icon name="clock" size={11} /> {deadlineStr}</Chip>
                                {met
                                  ? <Chip tone="burn"><Icon name="flame" size={11} stroke="var(--burn)" /> Threshold met</Chip>
                                  : <Chip tone="muted"><LiveDot on={motion !== 'off'} /> Open</Chip>}
                                {flipLabel}
                              </div>
                            </div>
                            <BalanceOfPowerBar
                              adopt={p.adopt_pot_e8s + p.lossless_adopt_e8s}
                              reject={p.reject_pot_e8s + p.lossless_reject_e8s}
                            />
                            <LosslessVoteRow
                              proposal={p}
                              myVote={myLosslessVotes.find(v => v.proposal_id === p.id)}
                              stakeE8s={myStake?.total_weight_e8s ?? 0n}
                              voting={losslessVoting === p.id}
                              onVote={handleLosslessVote}
                            />
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
                              {!isRetrying && myCommitment.status === CommitmentStatus.Pending
                                && (p.status === 'open' || p.status === 'met')
                                && remainingNs > 3_600_000_000_000 && (
                                <button
                                  onClick={() => handleAddMoreClick(p.id)}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    color: 'var(--burn)', fontSize: 11.5, padding: 0,
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    textDecoration: 'underline', whiteSpace: 'nowrap'
                                  }}
                                >
                                  + Add More
                                </button>
                              )}
                            </div>
                            <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                              <Icon name="info" size={12} stroke="var(--fg-3)" />
                              {met
                                ? 'Threshold met — when the neuron votes, your ICP is spent (50/25/25 treasury/backend/frontend; 25/25/25/25 when pool is active).'
                                : 'If the threshold misses, your committed ICP is returned.'}
                            </span>
                          </div>
                        </Reveal>
                      );
                    })}
                  </div>
                )}

                {activeTab === 'history' && (
                  <div className="col" style={{ gap: 12 }}>
                    <Reveal delay={160} motion={motion}>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                        <span className="row" style={{ gap: 8 }}>
                          <Icon name="list" size={13} stroke="var(--fg-2)" />
                          <b style={{ fontSize: 14, color: 'var(--fg)' }}>Past Proposals</b>
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {displayedPastItems.length}</span>
                        </span>
                        <Eyebrow style={{ whiteSpace: 'nowrap' }}>settled · cycles · returned</Eyebrow>
                      </div>
                    </Reveal>

                    {tier < 1 ? (
                      <Gate hint="Sign in to unlock" height={80} gating={gating}>
                        <div style={{ height: 60 }} />
                      </Gate>
                    ) : displayedPastItems.length === 0 ? (
                      <div style={{ padding: '12px 0', color: 'var(--fg-3)', fontSize: 13 }}>No settled proposals yet.</div>
                    ) : (
                      <div className="col" style={{ gap: 0 }}>
                        {displayedPastItems.map(item => {
                          if (item.proposal) {
                            const p = item.proposal;
                            const myCommitment = myCommitments.find(c => c.proposal_id === p.id);
                            const voteRec = voteHistory.find(r => r.proposal_id === p.id);
                            const isBurned = myCommitment?.status === CommitmentStatus.Burned;
                            return (
                              <div key={p.id.toString()} className="col" style={{
                                gap: 8, padding: '12px 0',
                                borderBottom: '1px solid var(--border)', width: '100%', minWidth: 0
                              }}>
                                <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'center', width: '100%', minWidth: 0, flexWrap: 'nowrap' }}>
                                  <span style={{ fontSize: 13, color: 'var(--fg-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={p.title}>
                                    {p.title}
                                  </span>
                                  <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                                    {p.total_committed_e8s < p.threshold_e8s && (
                                      <Chip tone="muted" style={{ height: 20, fontSize: 11, border: '1px dashed var(--border-hi)' }}>
                                        Threshold unmet
                                      </Chip>
                                    )}
                                    {voteRec && (
                                      <Chip tone={voteRec.vote === Vote.Yes ? 'ok' : 'muted'} style={{ height: 20, fontSize: 11 }}>
                                        {voteRec.vote === Vote.Yes ? 'Adopt' : voteRec.vote === Vote.No ? 'Reject' : 'abstained'}
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
                                      {fmtICP(myCommitment.amount_e8s)} ICP {isBurned ? 'spent' : 'returned'}
                                    </span>
                                  </div>
                                )}
                              </div>
                            );
                          } else if (item.record) {
                            const record = item.record;
                            const title = getProposalTitle(record.proposal_id);
                            const voteStr = record.vote === Vote.Yes ? 'Adopt' : record.vote === Vote.No ? 'Reject' : 'abstained';
                            return (
                              <div key={record.proposal_id.toString()} className="row" style={{
                                justifyContent: 'space-between', gap: 12, padding: '12px 0',
                                borderBottom: '1px solid var(--border)', width: '100%', minWidth: 0, flexWrap: 'nowrap'
                              }}>
                                <span style={{ fontSize: 13, color: 'var(--fg-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={title}>
                                  {title}
                                </span>
                                <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                                  {record.icp_burned_e8s === 0n && (
                                    <Chip tone="muted" style={{ height: 20, fontSize: 11, border: '1px dashed var(--border-hi)' }}>
                                      Threshold unmet
                                    </Chip>
                                  )}
                                  <Chip tone={record.vote === Vote.Yes ? 'ok' : 'muted'} style={{ height: 20, fontSize: 11 }}>{voteStr}</Chip>
                                  {record.icp_burned_e8s > 0n && (
                                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--burn)' }}>{fmtICP(record.icp_burned_e8s)} spent</span>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          )}
        </main>

        {/* ── Pool Sidebar (desktop — hidden on mobile, use FAB instead) ── */}
        {page === 'dashboard' && (
        <aside
          className="pool-sidebar-desktop"
          style={{
            width: poolSidebarCollapsed ? 44 : 280,
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg-alt)',
            flexDirection: 'column',
            overflowY: 'auto',
            overflowX: 'hidden',
            transition: 'width 180ms var(--ease-out)',
          }}
        >
          {/* Toggle header */}
          <button
            onClick={() => setPoolSidebarCollapsed(c => !c)}
            style={{
              padding: poolSidebarCollapsed ? '14px 0' : '11px 14px',
              display: 'flex', alignItems: 'center',
              justifyContent: poolSidebarCollapsed ? 'center' : 'space-between',
              gap: 6, background: 'transparent', border: 'none',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer', color: 'var(--fg-2)', flexShrink: 0,
              width: '100%', position: 'sticky', top: 0, zIndex: 2,
              backdropFilter: 'blur(8px)',
            }}
          >
            {!poolSidebarCollapsed && (
              <>
                <span className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
                  <NeuronGlyph size={15} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg)', textTransform: 'uppercase', letterSpacing: '0.09em', whiteSpace: 'nowrap' }}>
                    Pool Neurons
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
                  {poolInfo?.active_count.toString() ?? '0'} active
                </span>
              </>
            )}
            <Icon name={poolSidebarCollapsed ? 'chevRight' : 'chevDown'} size={14} stroke="var(--fg-3)" />
          </button>

          {/* Sidebar body */}
          {!poolSidebarCollapsed && (
            <div className="col" style={{ flex: 1, padding: 12, gap: 10 }}>
              {/* Explainer: always the first item in the list */}
              <Btn variant="secondary" sm style={{ width: '100%' }} onClick={() => setPoolDetailsOpen(true)}>
                <Icon name="info" size={12} /> More details
              </Btn>
              {/* Primary CTA */}
              {!myPoolNeuron && (
                <Btn
                  variant="primary"
                  sm
                  style={{ width: '100%' }}
                  onClick={() => { openPoolWizard(); setPoolMobileOpen(false); }}
                  disabled={!principal || principal.isAnonymous()}
                >
                  <Icon name="spark" size={13} stroke="var(--char-950)" />
                  {!principal || principal.isAnonymous() ? 'Sign in to join' : 'Join Pool'}
                </Btn>
              )}

              {/* My entry */}
              {myPoolNeuron && (
                <div className="col" style={{
                  gap: 7, padding: '9px 10px', borderRadius: 7,
                  border: '1px solid var(--border)', background: 'transparent',
                }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Your neuron</span>
                    {poolIs(myPoolNeuron.status, 'Active')
                      ? (myPoolRank != null && myPoolRank <= 25
                          ? <Chip tone="ok" style={{ height: 18, fontSize: 10 }}><Icon name="check" size={10} /> Active - Paid</Chip>
                          : <Chip tone="muted" style={{ height: 18, fontSize: 10 }}>Active</Chip>)
                      : poolIs(myPoolNeuron.status, 'Draft')
                      ? <Chip tone="pending" style={{ height: 18, fontSize: 10 }}>Draft</Chip>
                      : <Chip tone="muted" style={{ height: 18, fontSize: 10 }}>Inactive</Chip>}
                  </div>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', overflowWrap: 'anywhere' }}>
                    #{myPoolNeuron.neuron_id.toString()}
                  </span>
                  {poolIs(myPoolNeuron.status, 'Active') && (
                    <span className="mono" style={{ fontSize: 12, color: 'var(--sprout)' }}>
                      {fmtVP(myPoolNeuron.voting_power)} VP
                    </span>
                  )}
                  {(poolIs(myPoolNeuron.status, 'Draft') || poolIs(myPoolNeuron.status, 'Inactive')) && (
                    <Btn variant="primary" sm style={{ width: '100%', marginTop: 2 }} onClick={() => openPoolWizard()}>
                      <Icon name="arrowUp" size={12} stroke="var(--char-950)" />
                      {poolIs(myPoolNeuron.status, 'Draft') ? ' Resume setup' : ' Finish activation'}
                    </Btn>
                  )}
                  {poolIs(myPoolNeuron.status, 'Inactive') && (
                    <button
                      onClick={handleCancelPoolDraft} disabled={isCancellingDraft}
                      style={{ background: 'none', border: 'none', cursor: isCancellingDraft ? 'default' : 'pointer', color: 'var(--ember)', fontSize: 11.5, padding: '2px 0', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4, opacity: isCancellingDraft ? 0.5 : 1 }}
                    >
                      <Icon name="x" size={11} stroke="var(--ember)" /> {isCancellingDraft ? 'Clearing…' : 'Clear neuron'}
                    </button>
                  )}
                  {poolIs(myPoolNeuron.status, 'Active') && (
                    <button
                      onClick={() => setConfirmLeaveId(myPoolNeuron.neuron_id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ember)', fontSize: 11.5, padding: '2px 0', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <Icon name="x" size={11} stroke="var(--ember)" /> Leave pool
                    </button>
                  )}
                </div>
              )}

              {/* Other active neurons */}
              {(poolInfo?.active_neurons ?? [])
                .filter(n => !myPoolNeuron || n.neuron_id !== myPoolNeuron.neuron_id)
                .map(n => (
                  <div key={n.neuron_id.toString()} className="col" style={{
                    gap: 4, padding: '8px 10px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'transparent',
                  }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        #{n.neuron_id.toString()}
                      </span>
                      {n.rank <= 25
                        ? <Chip tone="ok" style={{ height: 17, fontSize: 10 }}><Icon name="check" size={9} /> Active - Paid</Chip>
                        : <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>Active</Chip>}
                    </div>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--sprout)' }}>{fmtVP(n.voting_power)} VP</span>
                  </div>
                ))
              }

              {(poolInfo?.active_count ?? 0n) === 0n && !myPoolNeuron && (
                <span style={{ fontSize: 12, color: 'var(--fg-3)', textAlign: 'center', padding: '12px 0', lineHeight: 1.5 }}>
                  No pool neurons yet. Join to amplify the syndicate's voting power.
                </span>
              )}
            </div>
          )}
        </aside>
        )}

        {/* Right Column: Tweak panel & Progression Ladder — local dev only */}
        {page === 'dashboard' && isLocal && dashControlsOpen && <aside style={{
          width: 320, padding: 24, borderLeft: '1px solid var(--border)', background: 'var(--bg-alt)',
          display: 'flex', flexDirection: 'column', gap: 24, flexShrink: 0, overflowY: 'auto'
        }}>
          {/* Tweak Panel Header */}
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div className="col" style={{ gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--burn)', letterSpacing: '0.1em' }}>
                Simulator & Tweaks
              </span>
              <h4 style={{ margin: 0, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>Dashboard Controls</h4>
            </div>
            <button onClick={() => setDashControlsOpen(false)} title="Close controls"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 2, flexShrink: 0 }}>
              <Icon name="x" size={16} />
            </button>
          </div>

          {/* One-click admin (local replica only — dev_become_admin is
              hard-blocked by require_local_dev, so this can't exist in prod) */}
          <div className="col" style={{ gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Admin access</span>
            {isAdmin ? (
              <Chip tone="ok"><Icon name="check" size={11} /> You are an admin</Chip>
            ) : (
              <Btn variant="secondary" sm onClick={async () => {
                if (!actor) return;
                const res = await actor.dev_become_admin();
                if (res.__kind__ === "Err") { alert(`Failed: ${res.Err}`); return; }
                await fetchConfig();
              }}>
                <Icon name="key" size={13} /> Make me admin (local only)
              </Btn>
            )}
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
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>Send test tokens to your wallet from the canister.</span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Btn variant="secondary" sm onClick={() => handleFaucet(IdeaToken.ICP)}>
                  <Icon name="zap" size={12} stroke="var(--burn)" /> 100 ICP
                </Btn>
                <Btn variant="secondary" sm onClick={() => handleFaucet(IdeaToken.CkBTC)}>
                  <Icon name="zap" size={12} stroke="var(--burn)" /> 0.1 ckBTC
                </Btn>
                <Btn variant="secondary" sm onClick={() => handleFaucet(IdeaToken.CkETH)}>
                  <Icon name="zap" size={12} stroke="var(--burn)" /> 1 ckETH
                </Btn>
              </div>
            </div>
          )}

          {/* Local dev: grab your principal to grant yourself admin via CLI */}
          {principal && !principal.isAnonymous() && !isAdmin && (
            <div className="simulator-panel col">
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>Become admin (dev)</span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                Copy your principal, then run from the dev1 identity:
                <span className="mono" style={{ display: 'block', marginTop: 4, color: 'var(--fg-3)', fontSize: 10.5 }}>
                  icp canister call backend add_admin '(principal "…")' --identity dev1 -e local
                </span>
              </span>
              <Btn variant="secondary" sm onClick={() => {
                navigator.clipboard.writeText(principal.toString());
                setHotkeyCopied(true);
                setTimeout(() => setHotkeyCopied(false), 2000);
              }}>
                <Icon name={hotkeyCopied ? "check" : "copy"} size={12} stroke={hotkeyCopied ? "var(--sprout)" : "var(--burn)"} /> Copy my principal
              </Btn>
            </div>
          )}
        </aside>}

        {/* Reopen tab — shown when the controls panel is closed */}
        {isLocal && !dashControlsOpen && (
          <button onClick={() => setDashControlsOpen(true)} title="Open Dashboard Controls"
            style={{
              position: 'fixed', top: 84, right: 0, zIndex: 50,
              background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRight: 'none',
              borderRadius: '6px 0 0 6px', padding: '8px 10px', cursor: 'pointer', color: 'var(--burn)',
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
            }}>
            <Icon name="zap" size={14} stroke="var(--burn)" /> Controls
          </button>
        )}

      </div>

      {/* ── Follow Neuron Modal (self-attested, Option C) ── */}
      {isFollowModalOpen && principal && !principal.isAnonymous() && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 440, width: '100%', gap: 16, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="checkCircle" size={18} stroke="var(--sprout)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Follow the leader neuron</h4>
              </span>
              {!isVerifying && (
                <button onClick={() => setIsFollowModalOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
              Cycles of Influence directs the community leader neuron based on
              what participants burn. We recommend also following it on the NNS
              so your own neuron votes the same way.
            </p>

            <div className="col" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, padding: '12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>How to follow (optional)</Eyebrow>
              <span><b style={{ color: 'var(--fg)' }}>1.</b> Open the NNS dapp → your neuron → <b>Following</b>.</span>
              <span><b style={{ color: 'var(--fg)' }}>2.</b> Under the <b>Governance</b> topic, add followee neuron:</span>
              <div className="row" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 4, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{formatNeuronId(config?.primary_neuron_id)}</span>
                <button onClick={() => { if (config) { navigator.clipboard.writeText(config.primary_neuron_id.toString()); setHotkeyCopied(true); setTimeout(() => setHotkeyCopied(false), 2000); } }}
                  title="Copy neuron id" style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name={hotkeyCopied ? "check" : "copy"} size={12} stroke={hotkeyCopied ? "var(--sprout)" : "var(--fg-3)"} />
                </button>
              </div>
              <a href="https://nns.ic0.app" target="_blank" rel="noreferrer" onClick={() => setNnsOpened(true)}
                style={{ fontSize: 12, color: 'var(--burn)', textDecoration: 'none' }}>
                <Icon name={nnsOpened ? "check" : "external"} size={11} stroke={nnsOpened ? "var(--sprout)" : "var(--burn)"} /> Open the NNS dapp
              </a>
            </div>

            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
              Following is encouraged but not enforced — your real conviction is the ICP you burn.
              {!nnsOpened && " Open the NNS dapp above to enable Done."}
            </span>

            <div className="row" style={{ gap: 12 }}>
              <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setIsFollowModalOpen(false)} disabled={isVerifying}>
                No thanks
              </Btn>
              <Btn variant="primary" style={{ flex: 1, opacity: nnsOpened ? 1 : 0.45 }} onClick={handleConfirmFollow} disabled={isVerifying || !nnsOpened}>
                {isVerifying ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={14} stroke="var(--char-950)" />}
                {isVerifying ? " Saving…" : " Done"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Treasury Wallet Modal (admin only) ── */}
      {isTreasuryOpen && isAdmin && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 460, width: '100%', gap: 16, background: 'var(--surface)',
            border: '1px solid var(--burn)', boxShadow: 'var(--elev-3)', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="wallet" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Treasury Wallet</h4>
              </span>
              <button onClick={() => setIsTreasuryOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 12px', borderRadius: 6, background: 'var(--burn-950)', border: '1px solid var(--burn)' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>Treasury balance</span>
              <span className="mono" style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)' }}>
                {treasuryBalance !== null ? `${fmtICP(treasuryBalance)} ICP` : "…"}
              </span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0, lineHeight: 1.5 }}>
              Accumulates the 0.005 ICP protocol fee per commit plus the treasury share of every settled proposal's proceeds. Without pool neurons: 50% treasury / 25% backend cycles / 25% frontend cycles. With active pool neurons: 25% treasury / 25% backend / 25% frontend / 25% pool. Withdraw to any principal.
            </p>

            {treasurySuccess && (
              <div style={{ padding: 10, borderRadius: 6, background: 'var(--sprout-dim)', border: '1px solid var(--sprout)', color: 'var(--sprout)', fontSize: 12.5 }}>Withdrawal sent.</div>
            )}
            {treasuryError && (
              <div style={{ padding: 10, borderRadius: 6, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>{treasuryError}</div>
            )}

            <input type="text" placeholder="Destination principal" className="burn-input" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              value={treasuryWithdrawTo} onChange={(e) => { setTreasuryWithdrawTo(e.target.value); setTreasuryError(null); setTreasurySuccess(false); }} />
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <input type="number" min="0" step="0.1" placeholder="Amount" className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                  value={treasuryWithdrawAmount} onChange={(e) => { setTreasuryWithdrawAmount(e.target.value); setTreasuryError(null); setTreasurySuccess(false); }} />
                <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>ICP</span>
              </div>
              <Btn variant="primary" sm onClick={handleTreasuryWithdraw} disabled={isTreasuryWithdrawing || !treasuryWithdrawTo || !treasuryWithdrawAmount}>
                {isTreasuryWithdrawing ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="arrowUp" size={13} stroke="var(--char-950)" />}
                {isTreasuryWithdrawing ? " Sending…" : " Withdraw"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Wallet Modal (deposit / withdraw) ── */}
      {isWalletOpen && principal && !principal.isAnonymous() && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 460, width: '100%', gap: 18, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="wallet" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Your app wallet</h4>
              </span>
              <button onClick={() => setIsWalletOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            {/* Balances — one row per token */}
            <div className="col" style={{ gap: 6, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>ICP</span>
                <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>{fmtICP(holdings)} ICP</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>ckBTC</span>
                <span className="mono" style={{ fontSize: 14, color: 'var(--fg-1)' }}>
                  {tokenBalances.ckbtc === null ? '…' : fmtTokenAmount(tokenBalances.ckbtc, tokenMeta(IdeaToken.CkBTC, boardInfo).decimals)} ckBTC
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>ckETH</span>
                <span className="mono" style={{ fontSize: 14, color: 'var(--fg-1)' }}>
                  {tokenBalances.cketh === null ? '…' : fmtTokenAmount(tokenBalances.cketh, tokenMeta(IdeaToken.CkETH, boardInfo).decimals)} ckETH
                </span>
              </div>
            </div>

            {/* Deposit */}
            <div className="col" style={{ gap: 8 }}>
              <Eyebrow>Deposit · fund your app account</Eyebrow>
              <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0, lineHeight: 1.5 }}>
                This is <b>your</b> app account. Send ICP via the legacy account identifier (NNS dapp / exchanges), or send ICP, ckBTC, or ckETH from any ICRC-1 wallet straight to your principal.
              </p>
              <label style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>ICP account identifier (for NNS / exchanges)</label>
              <div className="row" style={{ gap: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', overflowWrap: 'anywhere', flex: 1 }}>{accountId || "…"}</span>
                <button onClick={() => { navigator.clipboard.writeText(accountId); setAddrCopied("aid"); setTimeout(() => setAddrCopied(""), 2000); }}
                  title="Copy account identifier" style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name={addrCopied === "aid" ? "check" : "copy"} size={12} stroke={addrCopied === "aid" ? "var(--sprout)" : "var(--fg-3)"} />
                </button>
              </div>
              <label style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Principal (for ICP / ckBTC / ckETH from ICRC-1 wallets)</label>
              <div className="row" style={{ gap: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', overflowWrap: 'anywhere', flex: 1 }}>{principal.toString()}</span>
                <button onClick={() => { navigator.clipboard.writeText(principal.toString()); setAddrCopied("principal"); setTimeout(() => setAddrCopied(""), 2000); }}
                  title="Copy principal" style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name={addrCopied === "principal" ? "check" : "copy"} size={12} stroke={addrCopied === "principal" ? "var(--sprout)" : "var(--fg-3)"} />
                </button>
              </div>
            </div>

            <hr />

            {/* Withdraw */}
            <div className="col" style={{ gap: 8 }}>
              <Eyebrow>Withdraw · send tokens out</Eyebrow>
              <div className="row" style={{ gap: 6 }}>
                {TOKEN_ORDER.map(t => (
                  <Btn key={t} variant={walletToken === t ? 'primary' : 'secondary'} sm
                    onClick={() => { setWalletToken(t); setWithdrawTo(""); setWithdrawAmount(""); setWithdrawError(null); setWithdrawSuccess(false); }}>
                    <span className="mono">{tokenMeta(t, boardInfo).label}</span>
                  </Btn>
                ))}
              </div>
              {withdrawSuccess && (
                <div style={{ padding: 10, borderRadius: 6, background: 'var(--sprout-dim)', border: '1px solid var(--sprout)', color: 'var(--sprout)', fontSize: 12.5 }}>
                  Withdrawal sent.
                </div>
              )}
              {withdrawError && (
                <div style={{ padding: 10, borderRadius: 6, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                  {withdrawError}
                </div>
              )}
              <input type="text"
                placeholder={walletToken === IdeaToken.ICP ? "Destination Account ID (64-char hex)" : "Destination principal"}
                className="burn-input" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
                value={withdrawTo} onChange={(e) => { setWithdrawTo(e.target.value); setWithdrawError(null); setWithdrawSuccess(false); }} />
              <div className="row" style={{ gap: 8 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input type="text" inputMode="decimal" placeholder="Amount" className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                    value={withdrawAmount} onChange={(e) => { setWithdrawAmount(e.target.value); setWithdrawError(null); setWithdrawSuccess(false); }} />
                  <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>
                    {tokenMeta(walletToken, boardInfo).label}
                  </span>
                </div>
                <Btn variant="secondary" sm
                  onClick={walletToken === IdeaToken.ICP ? handleWithdraw : handleWithdrawIcrc}
                  disabled={isWithdrawing || !withdrawTo || !withdrawAmount}>
                  {isWithdrawing ? <LiveDot size={7} color="var(--fg)" /> : <Icon name="arrowUp" size={13} />}
                  {isWithdrawing ? " Sending…" : " Withdraw"}
                </Btn>
              </div>
              <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
                <Icon name="info" size={11} stroke="var(--fg-3)" />
                {walletToken === IdeaToken.ICP
                  ? 'ICP withdraws to a legacy Account ID (64-char hex). 0.0001 ICP network fee applies.'
                  : `${tokenMeta(walletToken, boardInfo).label} withdraws to a principal (ICRC-1). ${fmtTokenAmount(tokenMeta(walletToken, boardInfo).fee, tokenMeta(walletToken, boardInfo).decimals)} ${tokenMeta(walletToken, boardInfo).label} network fee applies.`}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Pool "More details" explainer ── */}
      {poolDetailsOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}
          onClick={() => setPoolDetailsOpen(false)}>
          <div className="card col" onClick={(e) => e.stopPropagation()} style={{
            maxWidth: 460, width: '100%', gap: 16, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
            maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="info" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>About the Neuron Pool</h4>
              </span>
              <button onClick={() => setPoolDetailsOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>What is the pool?</Eyebrow>
              <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                Members pool their neurons' voting power behind the syndicate's leader neuron. Each pooled neuron automatically votes the way the leader votes, and the combined voting power gives the syndicate more influence over NNS proposals.
              </p>
            </div>

            <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>Status badges</Eyebrow>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Chip tone="ok" style={{ height: 20, fontSize: 10, flexShrink: 0 }}><Icon name="check" size={10} /> Active - Paid</Chip>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  Ranked in the <strong style={{ color: 'var(--fg)' }}>top 25</strong> by voting power — earns a share of every settled proposal's payout.
                </span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Chip tone="muted" style={{ height: 20, fontSize: 10, flexShrink: 0 }}>Active</Chip>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  Voting with the pool, but outside the top 25 — not currently receiving payouts. Grow your voting power to move up the ranks.
                </span>
              </div>
            </div>

            <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>Voting power (VP)</Eyebrow>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                Each neuron contributes its NNS voting power to the pool. Neurons are ranked by VP — the higher your VP, the higher your rank, and the top 25 are the paid tier. The pool's total VP is the sum across all active neurons.
              </p>
            </div>

            <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>How to join</Eyebrow>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                Register your neuron, then pay the one-time initiation fee{config ? ` (${fmtICP(config.pool_initiation_fee_e8s + 30_000n)} ICP)` : ''} to activate it. The fee is split 50% to the treasury and 25% / 25% to backend and frontend cycle reserves. Once active, your neuron votes with the pool and is eligible for payouts if it reaches the top 25.
              </p>
            </div>

            <Btn variant="primary" style={{ width: '100%' }} onClick={() => setPoolDetailsOpen(false)}>Got it</Btn>
          </div>
        </div>
      )}

      {/* ── Leave-pool confirmation ── */}
      {confirmLeaveId !== null && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1100, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}
          onClick={() => { if (!isLeavingPool) setConfirmLeaveId(null); }}>
          <div className="card col" onClick={(e) => e.stopPropagation()} style={{
            maxWidth: 400, width: '100%', gap: 16, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
          }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <Icon name="x" size={18} stroke="var(--ember)" />
              <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Leave the pool?</h4>
            </div>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
              Your neuron <span className="mono" style={{ color: 'var(--fg)' }}>#{confirmLeaveId.toString()}</span> will become <strong style={{ color: 'var(--fg)' }}>Inactive</strong> and stop earning pool payouts. You can reactivate it later from the pool sidebar — the initiation fee is not refunded.
            </p>
            <div className="row" style={{ gap: 12 }}>
              <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setConfirmLeaveId(null)} disabled={isLeavingPool}>
                Cancel
              </Btn>
              <Btn variant="danger" style={{ flex: 1 }} onClick={() => handleUnregisterPool(confirmLeaveId)} disabled={isLeavingPool}>
                {isLeavingPool ? <LiveDot size={7} color="var(--ember)" /> : <Icon name="x" size={13} stroke="var(--ember)" />}
                {isLeavingPool ? ' Leaving…' : ' Leave pool'}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Pool Setup Wizard ── */}
      {isPoolWizardOpen && principal && !principal.isAnonymous() && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 460, width: '100%', gap: 18, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
            maxHeight: '90vh', overflowY: 'auto',
          }}>
            {/* Header */}
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="spark" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Join the Neuron Pool</h4>
              </span>
              {!isPoolVerifying && !isPoolFinalizing && !isCancellingDraft && (
                <button onClick={() => setIsPoolWizardOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            {/* Step indicators */}
            <div className="row" style={{ gap: 0 }}>
              {([1, 2, 3] as const).map((s, i) => (
                <React.Fragment key={s}>
                  <div style={{
                    flex: 1, height: 4, borderRadius: 2,
                    background: poolWizardStep >= s ? 'var(--burn)' : 'var(--char-800)',
                    transition: 'background 200ms',
                  }} />
                  {i < 2 && <div style={{ width: 4 }} />}
                </React.Fragment>
              ))}
            </div>

            {/* Step 1 — Intro */}
            {poolWizardStep === 1 && (
              <div className="col" style={{ gap: 14 }}>
                <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <Eyebrow>What is the pool?</Eyebrow>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                    Pool your neuron's voting power with the community leader. Your neuron automatically votes the same way the leader does, and you earn a share of each proposal's settlement proceeds.
                  </p>
                </div>
                <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <Eyebrow>Initiation fee</Eyebrow>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>One-time fee + cycle reserve</span>
                    <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>
                      {config ? fmtICP(config.pool_initiation_fee_e8s + 30_000n) : '…'} ICP
                    </span>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                    Split 50% treasury / 25% backend cycles / 25% frontend cycles. Payment is the final step — nothing is charged until you confirm.
                  </span>
                </div>
                <div className="row" style={{ gap: 12, marginTop: 4 }}>
                  <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setIsPoolWizardOpen(false)}>Cancel</Btn>
                  <Btn variant="primary" style={{ flex: 1 }} onClick={() => setPoolWizardStep(2)}>
                    <Icon name="chevRight" size={14} stroke="var(--char-950)" /> Continue
                  </Btn>
                </div>
              </div>
            )}

            {/* Step 2 — Configure & Verify */}
            {poolWizardStep === 2 && (
              <div className="col" style={{ gap: 14 }}>
                <Eyebrow accent>Step 2 of 3 — Verify your neuron (free)</Eyebrow>

                {/* Hotkey instruction */}
                <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                    1. Add this canister as a hotkey
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                    In the NNS dapp → your neuron → <b>Hotkeys</b>, add:
                  </span>
                  <div className="row" style={{ gap: 8, padding: '6px 10px', borderRadius: 5, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', flex: 1, overflowWrap: 'anywhere' }}>
                      {backendCanisterId}
                    </span>
                    <button onClick={() => { navigator.clipboard.writeText(backendCanisterId); }}
                      style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                      <Icon name="copy" size={12} stroke="var(--fg-3)" />
                    </button>
                  </div>
                </div>

                {/* Follow instruction */}
                <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                    2. Follow the leader neuron
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                    Under the <b>Governance</b> topic, add followee:
                  </span>
                  <div className="row" style={{ gap: 8, padding: '6px 10px', borderRadius: 5, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', flex: 1 }}>
                      {formatNeuronId(config?.primary_neuron_id)}
                    </span>
                    <button onClick={() => { if (config) navigator.clipboard.writeText(config.primary_neuron_id.toString()); }}
                      style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                      <Icon name="copy" size={12} stroke="var(--fg-3)" />
                    </button>
                  </div>
                  <a href="https://nns.ic0.app" target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: 'var(--burn)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="external" size={11} stroke="var(--burn)" /> Open NNS dapp
                  </a>
                </div>

                {/* Neuron ID input + verify */}
                <div className="col" style={{ gap: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>
                    Your neuron ID
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 4821667890123456789"
                    className="burn-input"
                    style={{ fontFamily: 'var(--font-mono)' }}
                    value={poolNeuronInput}
                    onChange={(e) => { setPoolNeuronInput(e.target.value); setPoolVerifyError(null); }}
                  />
                  {poolVerifyError && (
                    <div style={{ padding: '8px 10px', borderRadius: 5, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                      {poolVerifyError}
                    </div>
                  )}
                </div>

                <div className="row" style={{ gap: 12 }}>
                  <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setPoolWizardStep(1)} disabled={isPoolVerifying}>
                    Back
                  </Btn>
                  <Btn variant="primary" style={{ flex: 1 }} onClick={handlePoolVerify}
                    disabled={isPoolVerifying || !poolNeuronInput.trim()}>
                    {isPoolVerifying ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="checkCircle" size={13} stroke="var(--char-950)" />}
                    {isPoolVerifying ? ' Verifying…' : ' Verify'}
                  </Btn>
                </div>
              </div>
            )}

            {/* Step 3 — Pay */}
            {poolWizardStep === 3 && (
              <div className="col" style={{ gap: 14 }}>
                <Eyebrow accent>Step 3 of 3 — Finalize</Eyebrow>

                {poolFinalizeSuccess ? (
                  <div className="col" style={{ alignItems: 'center', gap: 14, padding: '12px 0', textAlign: 'center' }}>
                    <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--sprout-dim)', border: '1px solid var(--sprout)', display: 'grid', placeItems: 'center' }}>
                      <Icon name="checkCircle" size={24} stroke="var(--sprout)" />
                    </div>
                    <div className="col" style={{ gap: 4 }}>
                      <h5 style={{ margin: 0, color: 'var(--fg)' }}>Pool Neuron Active!</h5>
                      <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
                        Your neuron is now pooling its voting power with the syndicate. Payouts land in your app wallet after each settled proposal.
                      </p>
                    </div>
                    <Btn variant="primary" style={{ width: '100%' }} onClick={() => { setIsPoolWizardOpen(false); fetchPoolInfo(actor); }}>Done</Btn>
                  </div>
                ) : (
                  <>
                    <div className="col" style={{ gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                        {myPoolNeuron && poolIs(myPoolNeuron.status, 'Inactive')
                          ? 'Your neuron is inactive. Pay the initiation fee to reactivate it and start earning pool payouts again.'
                          : 'Your neuron draft is saved. Pay the initiation fee to activate it and start earning pool payouts.'}
                      </span>
                      <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Initiation fee</span>
                          <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
                            {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP
                          </span>
                        </div>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Cycle reserve</span>
                          <span className="mono" style={{ fontSize: 14, color: 'var(--fg)' }}>0.0003 ICP</span>
                        </div>
                        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>Total (from app wallet)</span>
                          <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--burn)' }}>
                            {config ? fmtICP(config.pool_initiation_fee_e8s + 40_000n) : '…'} ICP
                          </span>
                        </div>
                      </div>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--fg-3)' }}>
                        <span>App wallet balance</span>
                        <span className="mono">{fmtICP(holdings)} ICP</span>
                      </div>
                    </div>

                    {poolFinalizeError && (
                      <div style={{ padding: '8px 10px', borderRadius: 5, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                        {poolFinalizeError}
                      </div>
                    )}

                    <div className="row" style={{ gap: 12 }}>
                      {/* Discard only applies to a Draft — `cancel_pool_draft`
                          rejects Inactive (INVALID_STATE). Reactivating an
                          Inactive neuron, the user closes via the header X. */}
                      {(!myPoolNeuron || poolIs(myPoolNeuron.status, 'Draft')) && (
                        <Btn variant="danger" sm style={{ flexShrink: 0 }}
                          onClick={handleCancelPoolDraft}
                          disabled={isPoolFinalizing || isCancellingDraft}>
                          {isCancellingDraft ? <LiveDot size={7} color="var(--ember)" /> : <Icon name="x" size={12} stroke="var(--ember)" />}
                          {isCancellingDraft ? ' Cancelling…' : ' Discard'}
                        </Btn>
                      )}
                      <Btn variant="primary" style={{ flex: 1 }}
                        onClick={handlePoolPayAndFinalize}
                        disabled={isPoolFinalizing || isCancellingDraft || (config ? holdings < config.pool_initiation_fee_e8s + 40_000n : false)}>
                        {isPoolFinalizing ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="coins" size={14} stroke="var(--char-950)" />}
                        {isPoolFinalizing ? ' Processing…' : ' Pay & Activate'}
                      </Btn>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'center' }}>
                      Closing this dialog keeps your Draft saved — resume anytime from the pool sidebar.
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Transaction Confirmation Modal ── */}
      {isConfirming && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
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
                    Your {confirmAmount} ICP is locked in escrow. If the proposal reaches threshold and the neuron votes, it's spent — <b>50% treasury / 25% backend cycles / 25% frontend cycles</b> (with active pool neurons: 25% treasury / 25% backend / 25% frontend / 25% pool). If threshold isn't met, it's returned to your wallet.
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
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: 8 }}>
                    <div className="row" style={{ gap: 12, fontSize: 11.5, color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                      <span>Min: <span className="mono" style={{ color: 'var(--fg-2)' }}>1.0 ICP</span></span>
                      <span>Wallet: <span className="mono" style={{ color: 'var(--fg-2)' }}>{fmtICP(holdings)} ICP</span></span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsHelpOpen(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--burn)',
                        fontSize: 11.5,
                        cursor: 'pointer',
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        textDecoration: 'underline'
                      }}
                    >
                      <Icon name="info" size={11} stroke="var(--burn)" /> What is this?
                    </button>
                  </div>
                </div>

                {/* Live fee breakdown */}
                <div className="col" style={{ gap: 8, fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Committed weight</span>
                    <span className="mono">{confirmAmount ? parseFloat(confirmAmount).toFixed(4) : "—"} ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Protocol fee</span>
                    <span className="mono">0.0050 ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Ledger fees</span>
                    <span className="mono">0.0005 ICP</span>
                  </div>
                  <hr />
                  <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
                    <span style={{ color: 'var(--fg)' }}>Total debit</span>
                    <span className="mono" style={{ color: confirmAmount ? 'var(--burn)' : 'var(--fg-3)' }}>
                      {confirmAmount ? (parseFloat(confirmAmount) + 0.0055).toFixed(4) : "—"} ICP
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
                  ⚠️ <b>Commitment is final.</b> By confirming, you authorize a transfer from your wallet into a deterministic per-proposal escrow. The 0.005 ICP protocol fee is consumed immediately. If the proposal reaches threshold and the neuron votes, your committed ICP is spent — 50% to the treasury, 25% to backend-canister cycles, 25% to frontend-canister cycles. If threshold is not met, your ICP is returned (minus the 0.0001 ICP ledger fee).
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

      {/* ── Add More Commitment Modal ── */}
      {isAddingMore && (() => {
        const existingCommitment = addMoreProposalId
          ? myCommitments.find(c => c.proposal_id === addMoreProposalId)
          : null;
        return (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 440, width: '100%', gap: 20, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="flame" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Add to Commitment</h4>
              </span>
              {!isAddMoreTransacting && (
                <button onClick={() => setIsAddingMore(false)} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)'
                }}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            {addMoreTxError && (
              <div style={{
                padding: 12, borderRadius: 6, background: 'var(--ember-dim)',
                border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 13,
                lineHeight: 1.4
              }}>
                <b>Transaction Failed:</b> {addMoreTxError}
              </div>
            )}

            {addMoreTxSuccess ? (
              <div className="col" style={{ alignItems: 'center', textAlign: 'center', gap: 14, padding: '10px 0' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 999, background: 'var(--sprout-dim)',
                  border: '1px solid var(--sprout)', display: 'grid', placeItems: 'center',
                  color: 'var(--sprout)'
                }}>
                  <Icon name="checkCircle" size={24} stroke="var(--sprout)" />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <h5 style={{ margin: 0, color: 'var(--fg)' }}>Commitment Updated!</h5>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
                    Your additional {addMoreAmount} ICP has been added to your existing commitment. Your new total is locked in escrow under the same terms.
                  </p>
                </div>
                <Btn variant="primary" style={{ width: '100%', marginTop: 8 }} onClick={() => setIsAddingMore(false)}>
                  Close
                </Btn>
              </div>
            ) : (
              <div className="col" style={{ gap: 16 }}>
                {/* Existing commitment summary */}
                <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>PROPOSAL</span>
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--fg)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {getProposalTitle(addMoreProposalId || 0n)}
                  </span>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>CURRENT COMMITMENT</span>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)' }}>
                        {existingCommitment ? fmtICP(existingCommitment.amount_e8s) : '—'} ICP
                      </span>
                      {existingCommitment && (
                        <Chip tone={existingCommitment.stance === Stance.Adopt ? "ok" : "danger"} style={{ height: 18, fontSize: 10.5 }}>
                          {existingCommitment.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'}
                        </Chip>
                      )}
                    </span>
                  </div>
                </div>

                {/* Amount input */}
                <div className="col" style={{ gap: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
                    Additional ICP to add
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      placeholder="0.0"
                      className="burn-input"
                      style={{ fontSize: 22, padding: '10px 52px 10px 14px', fontFamily: 'var(--font-mono)' }}
                      value={addMoreAmount}
                      onChange={(e) => { setAddMoreAmount(e.target.value); setAddMoreTxError(null); }}
                      autoFocus
                    />
                    <span className="mono" style={{
                      position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                      fontSize: 14, color: 'var(--fg-3)', pointerEvents: 'none'
                    }}>ICP</span>
                  </div>
                  <div className="row" style={{ gap: 12, fontSize: 11.5, color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                    <span>Min: <span className="mono" style={{ color: 'var(--fg-2)' }}>1.0 ICP</span></span>
                    <span>Wallet: <span className="mono" style={{ color: 'var(--fg-2)' }}>{fmtICP(holdings)} ICP</span></span>
                  </div>
                </div>

                {/* Fee breakdown — simpler than initial commit */}
                <div className="col" style={{ gap: 8, fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Additional weight</span>
                    <span className="mono">{addMoreAmount ? parseFloat(addMoreAmount).toFixed(4) : "—"} ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--fg-2)' }}>Ledger fee</span>
                    <span className="mono">0.0001 ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--fg-3)' }}>
                    <span>Protocol fee</span>
                    <span className="mono" style={{ textDecoration: 'line-through' }}>waived (already paid)</span>
                  </div>
                  <hr />
                  <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
                    <span style={{ color: 'var(--fg)' }}>Total debit</span>
                    <span className="mono" style={{ color: addMoreAmount ? 'var(--burn)' : 'var(--fg-3)' }}>
                      {addMoreAmount ? (parseFloat(addMoreAmount) + 0.0001).toFixed(4) : "—"} ICP
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
                  ⚠️ <b>Top-up is final.</b> Your additional ICP will be deposited into the same escrow. No protocol fee is charged — only the 0.0001 ICP ledger transfer fee. Your stance ({existingCommitment?.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'}) cannot be changed.
                </div>

                {isAddMoreTransacting ? (
                  <div className="col" style={{ alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <LiveDot size={8} color="var(--burn)" />
                    <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{addMoreTxStep}</span>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 12 }}>
                    <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setIsAddingMore(false)}>
                      Cancel
                    </Btn>
                    <Btn
                      variant="primary"
                      style={{ flex: 1, opacity: addMoreAmount && parseFloat(addMoreAmount) >= 1 ? 1 : 0.45 }}
                      onClick={executeAddMore}
                    >
                      <Icon name="flame" size={14} stroke="var(--char-950)" /> Add {addMoreAmount ? `${parseFloat(addMoreAmount).toFixed(1)} ICP` : "ICP"}
                    </Btn>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* ── More Details Dialog ── */}
      {isDetailsOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 500, width: '100%', gap: 20, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
            maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="info" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>DAO Mechanics & Benefits</h4>
              </span>
              <button onClick={() => setIsDetailsOpen(false)} style={{
                background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
                padding: 4, display: 'grid', placeItems: 'center'
              }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="col" style={{ gap: 16, fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-2)' }}>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>How it Works</Eyebrow>
                <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <li>
                    <b>Follow the leader neuron:</b> Set your NNS neuron to follow the community leader neuron (ID <code>{formatNeuronId(config?.primary_neuron_id)}</code>), then confirm in-app to unlock voting. Following is encouraged but self-attested — the burn is the real signal.
                  </li>
                  <li>
                    <b>Commit ICP to a side:</b> On any open proposal, choose ADOPT or REJECT and commit ICP into a per-proposal escrow. Your committed weight (proportional to ICP) tilts the balance of power.
                  </li>
                  <li>
                    <b>Threshold &amp; vote:</b> One hour before the NNS deadline, if total committed ICP meets the threshold, the leader neuron casts the majority side's vote (an exact tie is broken by the first vote placed).
                  </li>
                  <li>
                    <b>Settlement:</b>
                    <ul style={{ margin: '4px 0 0 0', paddingLeft: 16, listStyleType: 'disc' }}>
                      <li>If the vote fires, your committed ICP is spent — <b>50% to the protocol treasury, 25% to backend-canister cycles, 25% to frontend-canister cycles</b> (the cycle portions are burned from ICP supply via the CMC).</li>
                      <li>If the threshold isn't met, your ICP is returned to your wallet (minus the 0.0001 ICP ledger fee).</li>
                    </ul>
                  </li>
                </ol>
              </div>

              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>How it Benefits You</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <li>
                    <b>Rented influence:</b> Combine your committed weight with others to direct the leader neuron's voting power on the proposals you care about.
                  </li>
                  <li>
                    <b>Nothing spent if it doesn't fire:</b> Your ICP is only spent when collective commitment meets the threshold and the vote is cast. Otherwise it's returned.
                  </li>
                </ul>
              </div>

              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>How it Benefits the ICP Community</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <li>
                    <b>Partial deflation:</b> Half of every settled commitment is converted to canister cycles via the CMC, removing that ICP from circulating supply.
                  </li>
                  <li>
                    <b>Self-sustaining:</b> The treasury and cycle top-ups keep the app running without external funding.
                  </li>
                  <li>
                    <b>Skin in the game:</b> Real ICP commitment aligns voting weight with conviction and prevents low-effort spam votes.
                  </li>
                </ul>
              </div>
            </div>

            <Btn variant="primary" style={{ width: '100%', marginTop: 8 }} onClick={() => setIsDetailsOpen(false)}>
              Got it
            </Btn>
          </div>
        </div>
      )}

      {/* ── Help / Definition Dialog ── */}
      {isHelpOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
          backdropFilter: 'blur(8px)', zIndex: 1100, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16
        }}>
          <div className="card col" style={{
            maxWidth: 480, width: '100%', gap: 18, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
            maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="info" size={18} stroke="var(--burn)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Understanding Burn Values</h4>
              </span>
              <button onClick={() => setIsHelpOpen(false)} style={{
                background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
                padding: 4, display: 'grid', placeItems: 'center'
              }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="col" style={{ gap: 14, fontSize: 13, lineHeight: 1.5, color: 'var(--fg-2)' }}>
              
              <div className="col" style={{ gap: 4 }}>
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Min Burn (1.0 ICP)</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  The minimum amount of ICP required to commit to any governance proposal. This ensures voting signals represent meaningful economic conviction and prevents spam.
                </p>
              </div>

              <div className="col" style={{ gap: 4 }}>
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Wallet Balance</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  The liquid ICP balance of your connected identity. This balance is used to fund your burn commitment and transaction fees.
                </p>
              </div>

              <div className="col" style={{ gap: 4 }}>
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Commitment Cap</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  Commits are capped by your wallet: the full amount must sit in escrow before it counts. No credit, no IOUs — every vote is backed by real ICP you've already put up.
                </p>
              </div>

              <hr />

              <div className="col" style={{ gap: 4 }}>
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Protocol Fee (0.005 ICP)</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  A flat fee charged by the Cycles of Influence protocol on each
                  commit transaction. This fee is immediately consumed and is
                  non-refundable, supporting canister compute costs and system
                  operations.
                </p>
              </div>

              <div className="col" style={{ gap: 4 }}>
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Ledger Fees (0.0003 ICP)</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  Standard ICP ledger transfer fees. The client pre-allocates 0.0003 ICP to ensure safe coverage of all transaction steps (e.g. transfer to escrow, and subsequent burn or refund). Only actual ledger costs (0.0001 ICP per transfer) will be consumed.
                </p>
              </div>

              <div className="col" style={{ gap: 4 }}>
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Total Debit</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  The total maximum ICP that will be temporarily debited from your connected wallet. If the proposal fails to meet its threshold, the committed amount is returned to you (minus the 0.0001 ICP refund transfer ledger fee).
                </p>
              </div>

            </div>

            <Btn variant="primary" style={{ width: '100%', marginTop: 8 }} onClick={() => setIsHelpOpen(false)}>
              Close
            </Btn>
          </div>
        </div>
      )}

      {/* ── Mobile Menu Drawer Overlay ── */}
      <div
        className={`mobile-drawer-overlay ${mobileMenuOpen ? 'open' : ''}`}
        onClick={() => setMobileMenuOpen(false)}
      />

      {/* ── Mobile Menu Drawer ── */}
      <div className={`mobile-drawer ${mobileMenuOpen ? 'open' : ''}`}>
        {/* Drawer Header */}
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24, width: '100%' }}>
          <span className="row" style={{ gap: 8 }}>
            <span style={{
              width: 28, height: 28, display: 'grid', placeItems: 'center',
              border: '1px solid var(--burn)', borderRadius: 6, background: 'var(--burn-950)'
            }}>
              <Icon name="flame" size={15} stroke="var(--burn)" />
            </span>
            <b style={{ fontSize: 16, color: 'var(--fg)', fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}>
              Cycles of Influence
            </b>
          </span>
          <button
            onClick={() => setMobileMenuOpen(false)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--fg-2)', padding: 4, display: 'flex', alignItems: 'center'
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Drawer Navigation Links */}
        <div className="col" style={{ gap: 8, width: '100%', marginBottom: 32 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Navigation</Eyebrow>
          {renderNavLinks(() => setMobileMenuOpen(false))}
        </div>

        {/* Drawer Identity & Wallet */}
        <div className="col" style={{ gap: 8, width: '100%', marginTop: 'auto' }}>
          <Eyebrow style={{ marginBottom: 6 }}>Account</Eyebrow>

          <Btn
            variant="ghost"
            style={{ justifyContent: 'flex-start', width: '100%', height: 38, marginBottom: 8 }}
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          >
            <Icon name="spark" size={14} />
            Theme: {theme.toUpperCase()}
          </Btn>

          {!principal || principal.isAnonymous() ? (
            <Btn
              variant="primary"
              style={{ width: '100%', height: 40 }}
              onClick={() => { handleLogin(); setMobileMenuOpen(false); }}
              disabled={isSigningIn}
            >
              {isSigningIn ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="key" size={14} stroke="var(--char-950)" />}
              {isSigningIn ? " Opening II…" : " Sign in with Internet Identity"}
            </Btn>
          ) : (
            <div className="col" style={{ gap: 12, width: '100%' }}>
              {/* Wallet info */}
              <div className="col" style={{
                padding: '12px 14px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg)'
              }}>
                <span className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Principal</span>
                  <button
                    onClick={() => { navigator.clipboard.writeText(principal.toString()); setHotkeyCopied(true); setTimeout(() => setHotkeyCopied(false), 2000); }}
                    className="row"
                    style={{ gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    <span className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
                      {formatPrincipal(principal)}
                    </span>
                    <Icon name={hotkeyCopied ? "check" : "copy"} size={12} stroke={hotkeyCopied ? "var(--sprout)" : "var(--fg-3)"} />
                  </button>
                </span>
                <span className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Holdings</span>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--sprout)', fontWeight: 600 }}>
                    {fmtICP(holdings)} ICP
                  </span>
                </span>
              </div>

              {/* Wallet Actions */}
              <div className="row" style={{ gap: 8, width: '100%' }}>
                <Btn
                  variant="primary"
                  style={{ flex: 1, height: 38 }}
                  onClick={() => { setIsWalletOpen(true); setWithdrawError(null); setWithdrawSuccess(false); setMobileMenuOpen(false); }}
                >
                  <Icon name="wallet" size={14} stroke="var(--char-950)" /> Wallet
                </Btn>
                <Btn
                  variant="danger"
                  style={{ flex: 1, height: 38 }}
                  onClick={() => { handleLogout(); setMobileMenuOpen(false); }}
                >
                  <Icon name="x" size={14} stroke="var(--ember)" /> Sign out
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Simple type definitions helper
function Eyrow({ children }: { children: React.ReactNode }) {
  return <Eyebrow style={{ marginTop: 2 }}>{children}</Eyebrow>;
}
