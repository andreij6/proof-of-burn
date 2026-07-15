import React, { useState, useEffect, useRef } from 'react';
import { AuthClient } from "@icp-sdk/auth/client";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  createActor as createBackendActor,
  Vote,
  Stance,
  CommitmentStatus,
  ExplorerToken,
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
  ExplorerInfo,
  LotteryDraw,
} from "./bindings/backend";
import LotteryHub from "./LotteryHub";
import NeuronStakePage from "./NeuronStakePage";
import VoucherExchange from "./VoucherExchange";
import { friendlyVoucherErr, isPromo, type BondView } from "./Vouchers";
import { TIER_META } from "./Staking";
import DevDocs from "./DevDocs";
import ClaimPromo from "./ClaimPromo";
import AuthGate from "./AuthGate";
import MiniGolfPage from "./MiniGolfPage";
import LuckProofPage from "./LuckProofPage";
import DropZonePage from "./DropZonePage";
import BullRunPage from "./BullRunPage";
import IcpLp from "./IcpLp";
import Payouts from "./Payouts";
import Admin from "./Admin";
import Landing from "./Landing";
// Shared design-system primitives live in ui.tsx.
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, fmtICP, DiscordMark, DISCORD_INVITE, DevControlsContext, PageHelpContext, PageHelpMobile, BrandMark, OpenChatMark, OPENCHAT_URL } from './ui';
import { useTxFlow, TxModal } from './TxModal';
import { WALLET_TOKEN_META, parseTokenUnits, thresholdProgress, usdToTokenUnits, unitsToDecimalString, commitInsufficient, parseTokenAmount, fmtTokenAmount } from "./tokens";
import { useErrorImpression, trackScreen, trackConversion, setUserProps, setAnalyticsUser, icp } from "./analytics";
import { FriendlyError, backendErr, toFriendly, friendlyFromRaw, logRealError } from './errors';
import { countdownShort } from "./hubLogic";

// ── Shareable URL routing (hash-based; this is a static asset canister) ──
// Each in-app page maps to a stable hash path so links are copy-pasteable.
// The 'earn' page is now just Pool Neurons. Staking and Boosters (formerly
// Early Adopters) live on the 'lottery' page. 'staking' and 'early_adopters'
// are kept as route aliases that redirect to 'lottery' so old links work.
export type AppPage = 'landing' | 'auth' | 'voting' | 'earn' | 'staking' | 'lottery' | 'devdocs' | 'claim' | 'neuronstake' | 'exchange' | 'icplp' | 'luckproof' | 'dropzone' | 'bullrun' | 'minigolf' | 'course_market' | 'early_adopters' | 'payouts' | 'admin' | 'admin_money' | 'admin_economics' | 'admin_neurons' | 'admin_users' | 'admin_system' | 'admin_reference';

// The only pages an unauthenticated visitor can see. Everything else bounces
// to #/auth (which remembers the destination and continues there after
// Internet Identity completes) — so in-app pages never render signed-out.
export const PUBLIC_PAGES: AppPage[] = ['landing', 'claim', 'auth'];

export const PAGE_PATH: Record<AppPage, string> = {
  landing: '/',
  // The sign-in gate — the one page whose job is authentication.
  auth: '/auth',
  voting: '/voting',
  earn: '/earn',
  staking: '/staking',
  lottery: '/lottery',
  // Developer docs — how to embed the No-Loss Lottery in another dapp.
  devdocs: '/dev-docs',
  // Golden Ticket claim campaign — standalone landing-style page (the link
  // shared on X/OpenChat); reachable signed-out, no nav entry.
  claim: '/claim',
  // Neuron Stake — the pooled-neuron staking page (was the Lottery hub's
  // "Stake to Earn Tickets" tab); Stake to Earn nav section.
  neuronstake: '/neuron-stake',
  // Voucher Exchange — the stake-voucher secondary market.
  exchange: '/exchange',
  // ICPSwap LP staking — Task 4 Tickets nav.
  icplp: '/icp-lp',
  // Luck-Proof (Sklansky Trainer) has its own nav page below Lottery, gated
  // on the arcade_luckproof per-game flag.
  luckproof: '/luck-proof',
  // Drop Zone (target skydive) — own nav page below Luck-Proof, gated on the
  // arcade_skydive per-game flag.
  dropzone: '/drop-zone',
  // Bull Run (encierro lane-runner) — Play to Earn nav, arcade_bullrun flag.
  bullrun: '/bull-run',
  // Mini Golf — gated on the arcade_minigolf flag; `#/mini-golf/course/<id>`,
  // `#/mini-golf/spectate/<id>` and `#/mini-golf/play/<id>` deep links resolve
  // here (as do legacy `#/arcade/...` links from before the hub was removed).
  minigolf: '/mini-golf',
  // The Course Marketplace is the Mini Golf lobby (PB-309); kept as a
  // deep-linkable alias that redirects to the Mini Golf page (same flag gate).
  course_market: '/courses',
  early_adopters: '/early_adopters',
  payouts: '/profile',
  // Bare /admin is a legacy alias — it redirects to the Money page (the
  // console's four sections are each their own page, owner 2026-07-11).
  admin: '/admin',
  admin_money: '/admin/money',
  admin_economics: '/admin/economics',
  admin_neurons: '/admin/neurons',
  admin_users: '/admin/users',
  admin_system: '/admin/system',
  admin_reference: '/admin/reference',
};
/** The Earn page renders for these three (tab = which one is active). */
const EARN_PAGES: AppPage[] = ['earn'];
const PATH_PAGE: Record<string, AppPage> = Object.fromEntries(
  Object.entries(PAGE_PATH).map(([p, path]) => [path, p as AppPage])
) as Record<string, AppPage>;

/** IC docs on NNS neuron hotkeys (Neuron Syndicate onboarding). */
const NNS_HOTKEY_DOCS = "https://docs.internetcomputer.org/concepts/governance/#neuron-hotkeys";

/** Page named by the current URL hash, or null when at the root / unknown. */
// Hub pages keep their active sub-screen in a trailing hash segment (e.g.
// /casino/crash, /arcade/course-play, /lottery/staking — see useHashScreen).
// Resolve any such deep path back to its hub page so the top-level router stays
// on the hub while the sub-screen changes.
const HUB_PATHS = ['/mini-golf', '/lottery'] as const;
export function pageFromHash(hash: string): AppPage | null {
  const h = hash.replace(/^#/, '');
  if (/^proposal-\d+$/.test(h)) return 'voting'; // shared proposal deep link
  const path = '/' + h.replace(/^\//, '');
  // The staking tab moved out of the Lottery hub — honor old deep links.
  if (path === '/lottery/staking') return 'neuronstake';
  // Vouchers merged into the Neuron Stake page (2026-07-10).
  if (path === '/vouchers' || path.startsWith('/vouchers/')) return 'neuronstake';
  // The Arcade hub was removed (2026-07) — its shared course deep links
  // (`#/arcade/course/<id>` et al.) resolve to the Mini Golf page, whose
  // hash-screen routing reads the same trailing segments.
  if (path === '/arcade' || path.startsWith('/arcade/')) return 'minigolf';
  const hub = HUB_PATHS.find((p) => path === p || path.startsWith(p + '/'));
  if (hub) return PATH_PAGE[hub];
  return PATH_PAGE[path] ?? null;
}

export type WalletToken = 'ICP' | 'ckBTC' | 'ckETH' | 'ckUSDC' | 'ckUSDT';
export const WALLET_TOKENS: WalletToken[] = ['ICP', 'ckBTC', 'ckETH', 'ckUSDC', 'ckUSDT'];

// ── Shared commitment minimum ──
// Every commitment — an initial vote on an Open proposal OR an "add more"
// top-up — must be worth at least $1, valued at the live XRC rate. The backend
// enforces this regardless; these are the single source of truth on the client
// so the Open-proposal flow and the add-more flow can never drift apart.
export const MIN_COMMIT_USD = 1;
export const MIN_COMMIT_USD_E8S = BigInt(MIN_COMMIT_USD) * 100_000_000n;

/** USD-e8s value of `amountIcp` ICP at the given ICP→USD rate (e8s); 0 when the
 *  amount is invalid or the rate is unknown. */
export function icpToUsdE8s(amountIcp: number, icpRateUsd: bigint): bigint {
  if (!isFinite(amountIcp) || amountIcp <= 0 || icpRateUsd <= 0n) return 0n;
  return BigInt(Math.round(amountIcp * 1e8)) * icpRateUsd / 100_000_000n;
}

/** Does an ICP amount clear the shared $1 commitment minimum? When the rate is
 *  unknown we can't value it client-side, so we don't block (any positive
 *  amount passes here; the backend still enforces the floor). */
export function meetsMinCommitIcp(amountIcp: number, icpRateUsd: bigint): boolean {
  if (icpRateUsd <= 0n) return isFinite(amountIcp) && amountIcp > 0;
  return icpToUsdE8s(amountIcp, icpRateUsd) >= MIN_COMMIT_USD_E8S;
}

/** Did a proposal reach its burn threshold? ICP-threshold proposals compare
 *  directly; USD-threshold ones need the live rate — when it's unknown we
 *  don't claim "unmet" (so we never hide a row we can't actually evaluate). */
export function proposalThresholdMet(
  p: { total_committed_e8s: bigint; threshold_e8s: bigint; threshold_usd_e8s?: bigint },
  icpRateUsd: bigint,
): boolean {
  if (!p.threshold_usd_e8s) return p.total_committed_e8s >= p.threshold_e8s;
  if (icpRateUsd <= 0n) return true;
  return thresholdProgress(p, icpRateUsd).pct >= 100;
}

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
        <span style={{ color: 'var(--sprout-ink)' }}>ADOPT {empty ? "—" : `${adoptPct.toFixed(0)}%`}</span>
        <span style={{ color: 'var(--fg-3)' }}>balance of power</span>
        <span style={{ color: 'var(--ember)' }}>{empty ? "—" : `${rejectPct.toFixed(0)}%`} REJECT</span>
      </div>
      <div className="row" style={{ height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--border)' }}>
        {empty ? (
          <div style={{ width: '100%', height: '100%', background: 'var(--border)' }} />
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
      <div style={{ height: 8, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
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
          <span className="mono" style={{ fontSize: 12, color: met ? 'var(--sprout-ink)' : 'var(--burn-ink)', fontWeight: 500, whiteSpace: 'nowrap' }}>
            {req}
          </span>
        </div>
      )}
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

// AIPanel Component
function AIPanel({ open, onToggle, score, text }: { open: boolean; onToggle: () => void; score: string; text: string }) {
  return (
    <div style={{ border: '1px solid var(--burn)', borderRadius: 8, background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))', overflow: 'hidden' }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, padding: '9px 12px', background: 'transparent', border: 'none', cursor: 'pointer'
      }}>
        <span className="row" style={{ gap: 7, color: 'var(--burn-ink)', fontSize: 13 }}>
          <Icon name="spark" size={14} stroke="var(--burn-ink)" /> AI review
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

/** Human page titles for document.title / analytics (Firebase breaks views
 *  out by 'Page title'). Keyed by AppPage; falls back to 'Cycle Burn'. */
const PAGE_TITLE: Record<AppPage, string> = {
  landing: 'Home', auth: 'Sign in', voting: 'Voting', earn: 'Neuron Syndicate',
  staking: 'Stake', lottery: 'No-Loss Lottery', devdocs: 'Developer Docs',
  claim: 'Golden Ticket', neuronstake: 'Stake', exchange: 'Bond Exchange',
  icplp: 'Liquidity Provider', luckproof: 'Luck-Proof', dropzone: 'Drop Zone',
  bullrun: 'Bull Run', minigolf: 'Mini Golf', course_market: 'Course Market',
  early_adopters: 'Early Adopters', payouts: 'Wallet', admin: 'Admin',
  admin_money: 'Admin · Money', admin_economics: 'Admin · Economics',
  admin_neurons: 'Admin · Neurons', admin_users: 'Admin · Users',
  admin_system: 'Admin · System', admin_reference: 'Admin · How it works',
};

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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [poolDetailsOpen, setPoolDetailsOpen] = useState(false);
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
  // Wallet voucher rail (withdraw a voucher to another wallet principal).
  const [walletVouchers, setWalletVouchers] = useState<BondView[]>([]);
  const [voucherXferId, setVoucherXferId] = useState<bigint | null>(null);
  const [voucherXferTo, setVoucherXferTo] = useState("");
  const [voucherXferBusy, setVoucherXferBusy] = useState(false);
  const [voucherXferMsg, setVoucherXferMsg] = useState<string | null>(null);

  // Load the caller's bonds when the wallet opens (best-effort — empty
  // when the lottery flag is off; bonds ride the lossless_lottery flag).
  const loadWalletVouchers = async () => {
    if (!actor) return;
    try {
      const info = await actor.get_bond_market();
      setWalletVouchers(info?.my_bonds ?? []);
    } catch { setWalletVouchers([]); }
  };
  useEffect(() => {
    if (isWalletOpen) loadWalletVouchers();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [isWalletOpen, actor]);

  const handleVoucherTransfer = async (id: bigint) => {
    if (voucherXferBusy) return;
    setVoucherXferBusy(true); setVoucherXferMsg(null);
    try {
      let to: Principal;
      try {
        to = Principal.fromText(voucherXferTo.trim());
        if (to.isAnonymous()) throw new Error();
      } catch { setVoucherXferMsg(friendlyVoucherErr('INVALID_PRINCIPAL')); return; }
      const res = await actor.transfer_bond(id, to);
      if (res.__kind__ === 'Err') { setVoucherXferMsg(friendlyVoucherErr(res.Err)); return; }
      setVoucherXferId(null); setVoucherXferTo("");
      setVoucherXferMsg(`Bond #${id} sent — it now lives in ${voucherXferTo.trim().slice(0, 8)}… and earns tickets there.`);
      await loadWalletVouchers();
    } catch (e: any) { setVoucherXferMsg(toFriendly(e, 'wallet:bond-transfer')); }
    finally { setVoucherXferBusy(false); }
  };

  // Transaction / Modal state
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransacting, setIsTransacting] = useState(false);
  const [txStep, setTxStep] = useState<string>("");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState(false);
  // Staged transaction modal that takes over AFTER the confirm dialog: it shows
  // each on-chain stage updating live (escrow → ledger → finalize) and, on
  // failure, the plain-English reason. The confirm dialog above stays purely an
  // input/validation step.
  const commitTx = useTxFlow();
  const [confirmProposalId, setConfirmProposalId] = useState<bigint | null>(null);
  const [confirmAmount, setConfirmAmount] = useState<string>(""); // token amount (derived from USD)
  const [confirmUsd, setConfirmUsd] = useState<string>("");       // dollar amount (the input)
  const [confirmStance, setConfirmStance] = useState<Stance | null>(null);
  // Vote dialog: conviction burn (voting is burn-only).
  // Voting is ICP-only.
  // Voting is ICP-only (non-ICP commit support removed). Kept as a typed const
  // so existing references (pricing, gating) compile unchanged.
  const voteToken: WalletToken = 'ICP';
  // Cached USD rates (e8s of USD per whole token) for $ thresholds/previews.
  const [usdRates, setUsdRates] = useState<Record<string, bigint>>({});
  // Bumping this opens the Profile page on its Wallet tab.
  const [walletRequest, setWalletRequest] = useState(0);

  // Add-more modal state (top up existing commitment)
  const [isAddingMore, setIsAddingMore] = useState(false);
  const [addMoreProposalId, setAddMoreProposalId] = useState<bigint | null>(null);
  const [addMoreAmount, setAddMoreAmount] = useState("");
  const [addMoreTxStep, setAddMoreTxStep] = useState("");
  const [addMoreTxError, setAddMoreTxError] = useState<string | null>(null);
  const [addMoreTxSuccess, setAddMoreTxSuccess] = useState(false);
  const [isAddMoreTransacting, setIsAddMoreTransacting] = useState(false);
  // Staged transaction modal for the add-more (top-up) flow — same role as
  // commitTx above, driven independently.
  const addMoreTx = useTxFlow();

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

  // Analytics: fire an error_shown impression whenever a user-facing error renders.
  useErrorImpression(txError, 'vote_commit');
  useErrorImpression(withdrawError, 'withdraw');
  useErrorImpression(treasuryError, 'treasury_withdraw');
  useErrorImpression(poolVerifyError, 'pool_verify');
  useErrorImpression(poolFinalizeError, 'pool_finalize');
  useErrorImpression(addMoreTxError, 'add_more');

  // Tweak / simulator options
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  // Visual presentation is now fixed (the per-style selectors were removed
  // from the Dashboard & Controls panel): AI review is off by default, and
  // motion is always the expressive page-transition style.
  const aiMode: string = 'hidden';
  const motion: string = 'expressive';
  // Page-local dev controls registered by the open page (see DevControlsContext)
  // and surfaced in the Dashboard & Controls panel.
  const [pageDevControls, setPageDevControls] = useState<React.ReactNode>(null);
  // "How it works" content the open page registers (see PageHelpContext),
  // shown in the persistent right panel (desktop) / collapsible (mobile).
  const [pageHelp, setPageHelp] = useState<React.ReactNode>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState<boolean>(false);

  // Input states for each proposal
  const [aiOpenMap, setAiOpenMap] = useState<Record<string, boolean>>({});

  // Next lottery drawing time (for the nav badge). Anonymous-allowlisted query.
  const [nextDrawAt, setNextDrawAt] = useState<bigint | null>(null);
  // Bookmark hint: browsers block programmatic bookmarking, so clicking the
  // star reveals the platform shortcut (and copies the URL as a fallback).
  const [bookmarkHint, setBookmarkHint] = useState(false);
  const isMacLike = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const bookmarkShortcut = isMacLike ? '⌘ + D' : 'Ctrl + D';
  const handleBookmark = () => {
    try { navigator.clipboard?.writeText(window.location.origin); } catch { /* ignore */ }
    setBookmarkHint(true);
    setTimeout(() => setBookmarkHint(false), 4000);
  };

  // Active tab selection
  const [activeTab, setActiveTab] = useState<'open' | 'committed' | 'history'>('open');
  // Past Proposals pagination (50 per page; latest 250 only).
  const [historyPage, setHistoryPage] = useState(0);
  // Lottery win banner — shows the winner a celebratory banner for 2 days after a
  // draw finalizes; dismissible and remembered per draw id so it won't nag.
  const [winBanner, setWinBanner] = useState<{ id: bigint; prize: bigint } | null>(null);
  useEffect(() => {
    if (!actor || !principal || principal.isAnonymous()) { setWinBanner(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const winners: LotteryDraw[] = await actor.list_recent_winners();
        const me = principal.toString();
        const TWO_DAYS_MS = 2 * 86_400_000;
        const mine = winners
          .filter(d => !!d.winner && d.winner.toString() === me
            && Date.now() - Number(d.drawn_at / 1_000_000n) < TWO_DAYS_MS)
          .sort((a, b) => (b.drawn_at > a.drawn_at ? 1 : b.drawn_at < a.drawn_at ? -1 : 0))[0];
        if (cancelled) return;
        if (mine && localStorage.getItem(`lottery_win_seen_${mine.id}`) === null) {
          setWinBanner({ id: mine.id, prize: mine.prize_e8s });
          // The single most important conversion signal: the user just saw
          // they won. Once per win (the seen-flag gate above dedupes).
          trackConversion("lottery_win", { value: icp(mine.prize_e8s), currency: "ICP", draw_id: Number(mine.id) });
        } else {
          setWinBanner(null);
        }
      } catch { /* best-effort — no banner if the call fails */ }
    })();
    return () => { cancelled = true; };
  }, [actor, principal]);
  const dismissWinBanner = () => {
    if (winBanner) { try { localStorage.setItem(`lottery_win_seen_${winBanner.id}`, '1'); } catch { /* sandboxed */ } }
    setWinBanner(null);
  };

  // Help modal status
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // Page routing (dashboard | Community R&D | Lottery & Staking |
  // Payout history) + feature flags
  const [page, setPage] = useState<AppPage>(
    // The URL hash is the source of truth so links are shareable. A hash
    // naming a page (e.g. #/staking) opens it directly; the bare root opens
    // the landing page — signed-in visitors are bounced to the app by an
    // effect below once auth resolves.
    () => {
      if (typeof window === 'undefined') return 'landing';
      return pageFromHash(window.location.hash) ?? 'landing';
    }
  );
  // Every navigation lands at the TOP of the new page (the app shell owns
  // the scroll — <main> is the scroller, not the window).
  const mainScrollRef = useRef<HTMLElement | null>(null);
  useEffect(() => { mainScrollRef.current?.scrollTo({ top: 0 }); }, [page]);

  // Per-page document.title so Firebase/GA4 breaks views out by screen
  // (the 'Page title' dimension was always 'Cycle Burn' → everything
  // collapsed). Set the title, THEN fire the page_view so it carries it.
  useEffect(() => {
    const t = PAGE_TITLE[page] ?? 'Cycle Burn';
    document.title = page === 'landing' ? 'Cycle Burn — No-Loss Lottery on ICP' : `${t} · Cycle Burn`;
    trackScreen();
  }, [page]);
  // User navigations push a history entry (Back works); a redirect/alias/bounce
  // calls `redirect()` so the hash is *replaced* — Back then skips the page that
  // would only bounce forward again.
  // Seeded true so the first (mount) hash normalization replaces rather than
  // stacking an entry on a deep-linked URL.
  const navReplaceRef = useRef(true);
  const redirect = (p: AppPage) => { navReplaceRef.current = true; setPage(p); };
  // Proposal id from a shared link — scrolled to + highlighted once loaded.
  const [sharedProposalId, setSharedProposalId] = useState<string | null>(
    () => (typeof window !== 'undefined' && /^#proposal-\d+$/.test(window.location.hash))
      ? window.location.hash.slice('#proposal-'.length) : null
  );
  const [featureFlags, setFeatureFlags] = useState<FeatureFlag[]>([]);
  const refreshUsdRates = async (a: { get_usd_rates: () => Promise<{ token: string; rate_usd_e8s: bigint }[]> }) => {
    try {
      const rates = await a.get_usd_rates();
      const map: Record<string, bigint> = {};
      for (const r of rates) map[r.token] = r.rate_usd_e8s;
      setUsdRates(map);
    } catch { /* transient */ }
  };

  // Feature flag: the Community R&D page + nav are fully hidden when disabled
  // (the backend also rejects its update methods, so this is belt + braces).
  const losslessEnabled = featureFlags.find(f => f.key === 'lossless_voting')?.enabled ?? false;
  const lotteryEnabled = featureFlags.find(f => f.key === 'lossless_lottery')?.enabled ?? false;
  // Nav-section flags: the core of the app is the No-Loss Lottery — the
  // Governance and Community nav groups ship dark.
  const govNavEnabled = featureFlags.find(f => f.key === 'nav_governance')?.enabled ?? false;
  // Mini Golf has its own nav page (below Lottery), gated on its per-game flag
  // so it shows even when the full Arcade hub flag is off.
  const minigolfEnabled = featureFlags.find(f => f.key === 'arcade_minigolf')?.enabled ?? false;
  const luckproofEnabled = featureFlags.find(f => f.key === 'arcade_luckproof')?.enabled ?? false;
  const dropzoneEnabled = featureFlags.find(f => f.key === 'arcade_skydive')?.enabled ?? false;
  const bullrunEnabled = featureFlags.find(f => f.key === 'arcade_bullrun')?.enabled ?? false;
  const icpLpEnabled = featureFlags.find(f => f.key === 'icpswap_lp_stake')?.enabled ?? false;
  // Bonds are part of the lottery product (owner 2026-07-11): one flag, never toggled separately.
  const vouchersEnabled = lotteryEnabled;
  const earlyAdoptersEnabled = featureFlags.find(f => f.key === 'early_adopters')?.enabled ?? false;

  // Lossless staking: the caller's stake (earns lottery tickets only).

  // Explorer info is the wallet's token registry: unlike Config
  // (whose ckUSDC/ckUSDT overrides are local-only), its ledger ids resolve
  // on mainnet too (hard-pinned in the backend) — review 2026-06-11.
  const [explorerInfo, setExplorerInfo] = useState<ExplorerInfo | null>(null);
  const [tokenBalances, setTokenBalances] = useState<{ ckbtc: bigint | null; cketh: bigint | null; ckusdc: bigint | null; ckusdt: bigint | null }>({ ckbtc: null, cketh: null, ckusdc: null, ckusdt: null });
  const [walletToken, setWalletToken] = useState<WalletToken>('ICP');

  const getWalletTokenMeta = (t: WalletToken) => {
    switch (t) {
      case 'ICP':
        return {
          label: 'ICP',
          decimals: 8,
          fee: explorerInfo?.fee_icp_e8s ?? 10_000n,
          ledger: explorerInfo?.icp_ledger ?? Principal.fromText(ledgerCanisterId),
        };
      case 'ckBTC':
        return {
          label: 'ckBTC',
          decimals: 8,
          fee: explorerInfo?.fee_ckbtc_sats ?? 10n,
          ledger: explorerInfo?.ckbtc_ledger ?? (config?.ckbtc_ledger_canister_id || null),
        };
      case 'ckETH':
        return {
          label: 'ckETH',
          decimals: 18,
          fee: explorerInfo?.fee_cketh_wei ?? 2_000_000_000_000n,
          ledger: explorerInfo?.cketh_ledger ?? (config?.cketh_ledger_canister_id || null),
        };
      case 'ckUSDC':
        return {
          label: 'ckUSDC',
          decimals: 6,
          fee: explorerInfo?.fee_ckusdc_micro ?? 10_000n,
          ledger: explorerInfo?.ckusdc_ledger ?? config?.ckusdc_ledger_canister_id ?? null,
        };
      case 'ckUSDT':
        return {
          label: 'ckUSDT',
          decimals: 6,
          fee: explorerInfo?.fee_ckusdt_micro ?? 10_000n,
          ledger: explorerInfo?.ckusdt_ledger ?? config?.ckusdt_ledger_canister_id ?? null,
        };
    }
  };

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
      setExplorerInfo(await currentActor.get_explorer_info());
    } catch (err) {
      console.error("Failed to fetch token-registry info:", err);
    }
  };

  // ckBTC/ckETH/ckUSDC balances for the wallet (ICP balance = `holdings`).
  const fetchTokenBalances = async (info = explorerInfo) => {
    if (!info || !identity || !principal || principal.isAnonymous() || !config) {
      setTokenBalances({ ckbtc: null, cketh: null, ckusdc: null, ckusdt: null });
      return;
    }
    try {
      const mk = (lid: Principal) => createLedgerActor(lid.toString(), {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });
      const ckusdcLedger = explorerInfo?.ckusdc_ledger ?? config.ckusdc_ledger_canister_id;
      const ckusdtLedger = explorerInfo?.ckusdt_ledger ?? config.ckusdt_ledger_canister_id;
      const [ckbtc, cketh, ckusdc, ckusdt] = await Promise.all([
        mk(info.ckbtc_ledger).icrc1_balance_of({ owner: principal }),
        mk(info.cketh_ledger).icrc1_balance_of({ owner: principal }),
        ckusdcLedger ? mk(ckusdcLedger).icrc1_balance_of({ owner: principal }) : Promise.resolve(0n),
        ckusdtLedger ? mk(ckusdtLedger).icrc1_balance_of({ owner: principal }) : Promise.resolve(0n),
      ]);
      setTokenBalances({ ckbtc, cketh, ckusdc, ckusdt });
    } catch (err) {
      console.error("Failed to fetch token balances:", err);
    }
  };

  const fetchLeaderInfo = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const info = await currentActor.get_leader_neuron_info();
      refreshUsdRates(currentActor);
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
        logRealError('wallet:withdraw-legacy', err);
        setWithdrawError(`Transfer failed — ${detail}.`);
        return;
      }
      setWithdrawSuccess(true);
      setWithdrawAmount("");
      setWithdrawTo("");
      await refreshAllData();
    } catch (err: any) {
      if (err.message && err.message.includes("does not have method")) {
        logRealError('wallet:withdraw-legacy', err);
        setWithdrawError("Legacy Account ID transfers are not supported on the local dev ledger. Please deploy to mainnet to withdraw.");
      } else {
        setWithdrawError(toFriendly(err, 'wallet:withdraw-legacy'));
      }
    } finally {
      setIsWithdrawing(false);
    }
  };

  // Withdraw ckBTC/ckETH/ckUSDC (ICRC-1) to a destination principal.
  const handleWithdrawIcrc = async () => {
    if (!identity || isWithdrawing) return;
    setWithdrawError(null);
    const meta = getWalletTokenMeta(walletToken);
    if (!meta.ledger) {
      setWithdrawError("Token ledger canister ID not loaded yet.");
      return;
    }
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
    const bal = walletToken === 'ckBTC' ? tokenBalances.ckbtc
              : walletToken === 'ckETH' ? tokenBalances.cketh
              : walletToken === 'ckUSDT' ? tokenBalances.ckusdt
              : tokenBalances.ckusdc;
    if (bal !== null && units + meta.fee > bal) {
      setWithdrawError(`Insufficient balance (need amount + ${fmtTokenAmount(meta.fee, meta.decimals)} ${meta.label} fee).`);
      return;
    }
    setIsWithdrawing(true);
    try {
      const ledgerActor = createLedgerActor(meta.ledger.toString(), {
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
      setWithdrawError(toFriendly(err, 'wallet:withdraw'));
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

  // Share a proposal on X: a pre-filled tweet (web intent — the user posts
  // from their own account) with the proposal info and a deep link back to
  // this site (#proposal-<id> scrolls straight to the card).
  const shareProposalOnX = (p: Proposal) => {
    const id = (p.nns_proposal_id ?? p.id).toString();
    const title = p.title.length > 90 ? `${p.title.slice(0, 87)}…` : p.title;
    const commitment = myCommitments.find(c => c.proposal_id === p.id);
    const stance = commitment?.stance;
    const text = stance !== undefined
      ? `I'm backing ${stance === Stance.Adopt ? 'ADOPT' : 'REJECT'} on NNS proposal #${id} — “${title}” — on Cycle Burn. Burn ICP, move the vote. 🔥 $ICP`
      : `NNS proposal #${id} — “${title}” — is live on Cycle Burn. Burn ICP, move the vote. 🔥 $ICP`;
    const url = `${window.location.origin}/#proposal-${id}`;
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  // Shared-link landing: once proposals are in, scroll to the linked card
  // and pulse it. Matches both our internal id and the NNS proposal id.
  useEffect(() => {
    if (!sharedProposalId || proposals.length === 0) return;
    const el = document.getElementById(`proposal-card-${sharedProposalId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.boxShadow = '0 0 0 2px var(--burn)';
      setTimeout(() => { el.style.boxShadow = ''; }, 3000);
    }
    setSharedProposalId(null);
    try { history.replaceState(null, '', window.location.pathname); } catch { /* sandboxed */ }
  }, [sharedProposalId, proposals.length]);

  // ── Keep the URL hash in sync with the current page (shareable links) ──
  // Genuine navigations push a history entry so the Back button returns to the
  // previous page; redirects/aliases/bounces (see `redirect()`) replace instead,
  // so Back never lands on a page that just bounces forward again. A page change
  // that originated from Back/Forward already has the matching hash, so the
  // guard below skips it and we never double-push.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const desired = `#${PAGE_PATH[page]}`;
    // Don't clobber an unconsumed #proposal-<id> deep link.
    if (sharedProposalId && /^#proposal-\d+$/.test(window.location.hash)) return;
    if (window.location.hash !== desired && !(page === 'landing' && window.location.hash === '')) {
      if (navReplaceRef.current) history.replaceState(null, '', desired);
      else history.pushState(null, '', desired);
    }
    navReplaceRef.current = false;
  }, [page, sharedProposalId]);

  // Back/forward (or someone pasting a new hash) re-routes the page —
  // including #proposal-<id> deep links arriving while the app is open.
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/^#proposal-(\d+)$/);
      if (m) setSharedProposalId(m[1]);
      const p = pageFromHash(window.location.hash);
      setPage(p ?? 'landing');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Root + signed in → the app (default app page is Lottery). Signed-out
  // visitors at the root stay on the landing page (only an explicit "Go to
  // App" / a page link leaves it).
  useEffect(() => {
    if (page === 'landing' && principal && !principal.isAnonymous()) {
      redirect('lottery');
    }
  }, [page, principal]);

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
      const res = await actor.admin_withdraw_treasury(dest, e8s, false);
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
      logRealError('admin:treasury-withdraw', err);
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
        logRealError('syndicate:follow', res.Err);
        alert(`Could not record the follow: ${friendlyFromRaw(String(res.Err))}`);
      }
    } catch (err: any) {
      alert(toFriendly(err, 'syndicate:follow'));
    } finally {
      setIsVerifying(false);
    }
  };

  // Deriving the tier dynamically. Following the leader neuron is optional
  // (self-attested encouragement), so any signed-in user can vote (tier ≥ 2).
  const tier = !principal || principal.isAnonymous()
    ? 0
    : (myCommitments.length > 0 || (eligibility?.has_committed ?? false))
    ? 3
    : 2;

  // Redirect back to open if active tab is committed and tier drops below 2
  useEffect(() => {
    if (tier < 2 && activeTab === 'committed') {
      setActiveTab('open');
    }
  }, [tier, activeTab]);

  // If an admin kills a page's feature flag while someone is on it, bounce
  // them to a safe always-on page.
  useEffect(() => {
    // Staking moved onto the lottery page — redirect the legacy route alias.
    if (page === 'staking') {
      redirect('lottery');
    }
    if (page === 'lottery' && featureFlags.length > 0 && !lotteryEnabled) {
      redirect('lottery');
    }
    if ((page === 'voting' || page === 'earn') && featureFlags.length > 0 && !govNavEnabled) {
      redirect('lottery');
    }
    // The Course Marketplace is the Mini Golf lobby — redirect its alias.
    if (page === 'course_market') {
      redirect('minigolf');
    }
    // Mini Golf is a dedicated page for the arcade's mini-golf surface — gated
    // on its own per-game flag (independent of the full Arcade hub flag).
    if (page === 'minigolf' && featureFlags.length > 0 && !minigolfEnabled) {
      redirect('lottery');
    }
    if (page === 'luckproof' && featureFlags.length > 0 && !luckproofEnabled) {
      redirect('lottery');
    }
    if (page === 'dropzone' && featureFlags.length > 0 && !dropzoneEnabled) {
      redirect('lottery');
    }
    if (page === 'bullrun' && featureFlags.length > 0 && !bullrunEnabled) {
      redirect('lottery');
    }
    if (page === 'neuronstake' && featureFlags.length > 0 && !(losslessEnabled || earlyAdoptersEnabled)) {
      redirect('lottery');
    }
    if (page === 'exchange' && featureFlags.length > 0 && !vouchersEnabled) {
      redirect('lottery');
    }
    if (page === 'icplp' && featureFlags.length > 0 && !icpLpEnabled) {
      redirect('lottery');
    }
    if (page === 'claim' && featureFlags.length > 0 && !vouchersEnabled) {
      redirect('lottery');
    }
    // Boosters (formerly Early Adopters) moved onto the lottery page —
    // redirect the legacy route alias.
    if (page === 'early_adopters') {
      redirect('lottery');
    }
  }, [page, losslessEnabled, lotteryEnabled, vouchersEnabled, govNavEnabled, luckproofEnabled, dropzoneEnabled, bullrunEnabled, icpLpEnabled, earlyAdoptersEnabled, principal, featureFlags.length]);

  // ── The auth gate ──
  // Everything beyond the landing + claim pages requires a signed-in
  // principal. Unauthenticated visitors bounce to #/auth, which remembers
  // where they were headed and continues there after Internet Identity
  // completes. Only bounce once auth has resolved (principal === null means
  // AuthClient is still initializing; bouncing then killed deep links for
  // signed-in users — review 2026-06-11).
  const pendingAuthPageRef = useRef<AppPage | null>(null);
  useEffect(() => {
    if (PUBLIC_PAGES.includes(page)) return;
    if (principal && principal.isAnonymous()) {
      pendingAuthPageRef.current = page;
      redirect('auth');
    }
  }, [page, principal]);
  // Signed in on the gate (fresh login OR a signed-in deep link to #/auth) →
  // continue to the remembered destination, defaulting to the app.
  useEffect(() => {
    if (page === 'auth' && principal && !principal.isAnonymous()) {
      const dest = pendingAuthPageRef.current ?? 'lottery';
      pendingAuthPageRef.current = null;
      redirect(dest);
    }
  }, [page, principal]);

  // Lossless lottery: the daily ticket grant is tied to logging in, so claim
  // as soon as a signed-in actor exists (the Lottery page also claims for
  // users who keep the tab open across midnight UTC). Errors are expected
  // noise: ALREADY_CLAIMED_TODAY / FEATURE_DISABLED.
  useEffect(() => {
    if (!actor || !lotteryEnabled || !principal || principal.isAnonymous()) return;
    actor.claim_daily_tickets()
      .then((res: { __kind__: string; Ok?: bigint }) => {
        if (res?.__kind__ === "Ok") trackConversion("ticket_claim", { count: Number(res.Ok ?? 0n) });
      })
      .catch(() => {});
  }, [actor, principal, lotteryEnabled]);

  // Login ping: record this principal with the backend's "ever logged in"
  // registry so Admin → Users can list every signed-in principal (even those
  // with zero balance / no on-chain action). Fires once per session restore
  // AND after a fresh II login, since both set `actor` + `principal`. Fire and
  // forget — failures are noise (the next authenticated update re-pings).
  useEffect(() => {
    if (!actor || !principal || principal.isAnonymous()) return;
    actor.whoami().catch(() => {});
  }, [actor, principal]);

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
    actor.get_lottery_info().then((i: any) => setNextDrawAt(i?.next_draw_at ?? null)).catch(() => {});
  }, [actor]);

  // Refresh non-ICP balances whenever the wallet OR a commit modal opens — the
  // vote/add-more gate needs real balances or it falsely shows "Not enough funds".
  useEffect(() => {
    if (isWalletOpen || isConfirming || isAddingMore) {
      fetchTokenBalances();
    }
  }, [isWalletOpen, isConfirming, isAddingMore, explorerInfo, identity, config]);

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
        trackConversion("sign_in");
      },
      onError: () => setIsSigningIn(false),
    });
  };

  // Handle logout
  const handleLogout = async () => {
    if (!authClient) return;
    await authClient.logout();
    // Land on the public landing page — staying on a members-only page would
    // just bounce the fresh sign-out straight onto the #/auth gate.
    redirect('landing');
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


  // Keep the token amount (confirmAmount — what executeTransaction spends) in
  // sync with the USD the user entered and the selected currency. Switching
  // currency re-prices the same dollars into the new token.
  useEffect(() => {
    const meta = WALLET_TOKEN_META[voteToken];
    const rate = usdRates[meta.variant] ?? 0n;
    const units = usdToTokenUnits(parseFloat(confirmUsd), rate, meta.decimals);
    setConfirmAmount(units === null ? "" : unitsToDecimalString(units, meta.decimals));
  }, [confirmUsd, voteToken, usdRates]);

  // Open modal with stance pre-selected; amount is entered inside the modal
  const handleCommitClick = (proposalId: bigint, stance: Stance) => {
    setConfirmProposalId(proposalId);
    setConfirmStance(stance);
    setConfirmAmount("");
    setConfirmUsd("");
    setIsConfirming(true);
    setTxSuccess(false);
    setTxError(null);
    setTxStep("");
  };

  // Execute actual ledger + escrow saga
  const executeTransaction = async () => {
    if (!actor || !confirmProposalId || !confirmStance) return;

    // Voting is ICP-only. (Non-ICP commit support was removed.)

    const amount = parseFloat(confirmAmount);
    if (isNaN(amount) || amount <= 0) {
      setTxError("Please enter a valid amount.");
      return;
    }
    // Dollar-value voting: the floor is the shared $1-worth-of-ICP minimum
    // (matches the backend's XRC-valued minimum), not a fixed 1 ICP. Validate
    // client-side when the rate is known; the backend enforces it regardless.
    const icpRateUsd = usdRates[ExplorerToken.ICP] ?? 0n;
    if (!meetsMinCommitIcp(amount, icpRateUsd)) {
      setTxError(`Too small — votes start at $${MIN_COMMIT_USD} worth of ICP.`);
      return;
    }
    const amountE8s = BigInt(Math.floor(amount * 100_000_000));
    // Option C: capped by wallet balance only (no neuron stake cap).
    // Zero-fee commits: escrow receives exactly the amount; the wallet only
    // pays the one 0.0001 ICP ledger fee on the deposit transfer itself.
    const requiredTotal = amountE8s + 10_000n;
    if (requiredTotal > holdings) {
      setTxError(`Insufficient wallet balance — need at least ${fmtICP(requiredTotal)} ICP (amount + deposit fee).`);
      return;
    }

    const requiredDeposit = amountE8s;
    setIsTransacting(true);
    setTxError(null);

    // Hand off from the input dialog to the staged transaction modal, which
    // shows each on-chain stage live from here on.
    setIsConfirming(false);
    commitTx.start(
      ['Securing escrow', 'Transferring ICP', 'Finalizing commitment'],
      { title: 'Registering your vote', detail: 'Deriving your secure escrow subaccount…' },
    );

    try {
      // Step 1: Get deterministic escrow address
      const depositAccount = await actor.get_deposit_address(confirmProposalId);

      // Step 2: Transfer funds using ledger canister actor
      commitTx.next('Depositing your ICP into the escrow subaccount…');
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
        throw new FriendlyError(`The ledger transfer didn't go through — ${detail}.`, err, 'vote:commit-transfer');
      }

      // Step 3: Finalize commit on backend
      commitTx.next('Finalizing your commitment on-chain…');
      const commitResult = await actor.commit(confirmProposalId, confirmStance, amountE8s);

      if (commitResult.__kind__ === "Err") {
        const code = commitResult.Err as string;
        throw new FriendlyError(
          code === "BELOW_MINIMUM" ? "Too small — votes start at $1 worth of ICP."
          : code === "TREASURY_DEPLETED" ? "Voting is paused — the treasury can't currently cover the ledger fees this commitment needs. Your ICP is safe in escrow; try again shortly."
          : friendlyFromRaw(code),
          code, 'vote:commit',
        );
      }

      // Success!
      commitTx.succeed('Commitment registered — your ICP is locked in escrow for this proposal. If it reaches threshold and the neuron votes, it\'s spent; if not, it\'s returned in full.');
      // Land on the Committed tab so the user sees what they just voted on.
      setActiveTab('committed');

      // Refresh data
      await refreshAllData();

    } catch (err: any) {
      commitTx.fail(toFriendly(err, 'vote:commit'));
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
    if (isNaN(amount) || amount <= 0) {
      setAddMoreTxError("Please enter a valid amount.");
      return;
    }
    // Dollar-value voting: shared $1-worth-of-ICP floor (same decision as the
    // Open-proposal commit; backend enforces it too).
    const icpRateUsd = usdRates[ExplorerToken.ICP] ?? 0n;
    if (!meetsMinCommitIcp(amount, icpRateUsd)) {
      setAddMoreTxError(`Too small — top-ups start at $${MIN_COMMIT_USD} worth of ICP.`);
      return;
    }
    const amountE8s = BigInt(Math.floor(amount * 100_000_000));

    setIsAddMoreTransacting(true);
    setAddMoreTxError(null);

    // Hand off from the input dialog to the staged transaction modal.
    setIsAddingMore(false);
    addMoreTx.start(
      ['Checking your escrow', 'Funding escrow', 'Updating commitment'],
      { title: 'Adding to your commitment', detail: 'Checking your escrow balance…' },
    );

    try {
      // Step 1: escrow address + what's ALREADY deposited there. The escrow
      // holds exactly the committed ICP (zero-fee model), so we only deposit the
      // SHORTFALL needed to reach the new total. This also reclaims any ICP a
      // previously-failed top-up left stranded in escrow — in that case the
      // shortfall is 0 and we just reconcile the commitment on-chain.
      const depositAccount = await actor.get_deposit_address(addMoreProposalId);
      const ledgerActor = createLedgerActor(ledgerCanisterId, {
        agentOptions: { host, identity, rootKey: env?.IC_ROOT_KEY }
      });
      const escrowBalance: bigint = await ledgerActor.icrc1_balance_of({
        owner: depositAccount.owner,
        subaccount: depositAccount.subaccount ? depositAccount.subaccount : undefined,
      });
      const existing = myCommitments.find(c => c.proposal_id === addMoreProposalId)?.amount_e8s ?? 0n;
      const targetTotal = existing + amountE8s;
      const shortfall = targetTotal > escrowBalance ? targetTotal - escrowBalance : 0n;

      // Step 2: deposit only the shortfall (if any). Wallet must cover it plus
      // one ledger fee; when escrow already holds enough we skip the transfer.
      if (shortfall > 0n) {
        const need = shortfall + 10_000n;
        if (need > holdings) {
          throw new Error(`Insufficient wallet balance — need at least ${fmtICP(need)} ICP (top-up + deposit fee).`);
        }
        addMoreTx.next('Depositing additional ICP into escrow…');
        const transferResult = await ledgerActor.icrc1_transfer({
          to: {
            owner: depositAccount.owner,
            subaccount: depositAccount.subaccount ? depositAccount.subaccount : undefined
          },
          amount: shortfall,
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
          throw new FriendlyError(`The ledger transfer didn't go through — ${detail}.`, err, 'vote:commit-transfer');
        }
      } else {
        addMoreTx.next('Reclaiming ICP already in escrow…');
      }

      // Step 3: Finalize on backend
      addMoreTx.next('Updating your commitment on-chain…');
      const result = await actor.add_to_commitment(addMoreProposalId, amountE8s);

      if (result.__kind__ === "Err") {
        const code = result.Err as string;
        if (code === "BELOW_MINIMUM") throw new FriendlyError(`Too small — top-ups start at $${MIN_COMMIT_USD} worth of ICP.`, code, 'vote:add-more');
        if (code === "INSUFFICIENT_DEPOSIT") throw new FriendlyError("Deposit didn't register — your ICP is safe in escrow; try again in a moment.", code, 'vote:add-more');
        if (code === "TREASURY_DEPLETED") throw new FriendlyError("Top-ups are paused — the treasury can't currently cover the ledger fees this commitment needs. Your ICP is safe in escrow; try again shortly.", code, 'vote:add-more');
        throw backendErr(code, 'vote:add-more');
      }

      addMoreTx.succeed('Top-up registered — your additional ICP is locked in escrow under the same terms as your existing commitment.');
      await refreshAllData();

    } catch (err: any) {
      addMoreTx.fail(toFriendly(err, 'vote:add-more'));
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

  // Apply the theme to documentElement and remember the choice across reloads.
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try { localStorage.setItem('theme', theme); } catch { /* sandboxed */ }
  }, [theme]);

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
  // (top 100) vs plain "Active" consistently with the other member cards.
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
      setPoolVerifyError(toFriendly(err, 'pool:verify'));
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
      setPoolFinalizeError(toFriendly(err, 'pool:finalize'));
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

  // ── Analytics identity + segmentation ────────────────────────────────────
  // Identify the user to GA4 by a HASH of their principal (never the raw
  // principal) and set user properties so reports can segment — and so the
  // owner can FILTER admin traffic out. Best-effort; runs when the signed-in
  // actor / admin status settles.
  useEffect(() => {
    const signedIn = !!(principal && !principal.isAnonymous());
    setAnalyticsUser(signedIn ? principal!.toString() : null);
    if (!signedIn || !actor) {
      setUserProps({ signed_in: signedIn, is_admin: false });
      return;
    }
    let cancelled = false;
    (async () => {
      let hasBond = false, isStaked = false, isLp = false;
      try {
        const bm = await actor.get_bond_market();
        hasBond = (bm?.my_bonds?.length ?? 0) > 0;
      } catch { /* best-effort */ }
      try {
        const li = await actor.get_lottery_info();
        isStaked = !!li?.eligible; // true for neuron OR LP stakers
      } catch { /* best-effort */ }
      try {
        const lp = await actor.get_icp_lp_info();
        isLp = (lp?.my_positions?.length ?? 0) > 0;
      } catch { /* best-effort */ }
      if (cancelled) return;
      setUserProps({ signed_in: true, is_admin: isAdmin, is_staked: isStaked, has_bond: hasBond, is_lp: isLp });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, principal, isAdmin]);


  // Admin console pages are invisible to non-admins; bounce them once auth
  // AND config have resolved, so a deep link survives the cold load for
  // actual admins. Bare /admin aliases to the Money page.
  const ADMIN_PAGES: AppPage[] = ['admin_money', 'admin_economics', 'admin_neurons', 'admin_users', 'admin_system', 'admin_reference'];
  useEffect(() => {
    if (page === 'admin') {
      setPage('admin_money');
      return;
    }
    if (ADMIN_PAGES.includes(page) && principal && config && !isAdmin) {
      setPage('lottery');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, isAdmin, principal, config]);

  // Single source of truth for site navigation — rendered in the persistent
  // desktop sidebar AND the mobile drawer. Grouped by intent:
  // Dashboard → Participate (Voting / R&D / Explorer / Earn) → Play (Arcade / Lottery).
  const renderNavLinks = (onNavigate?: () => void) => {
    const go = (p: typeof page) => { setPage(p); onNavigate?.(); };
    const linkStyle: React.CSSProperties = { justifyContent: 'flex-start', width: '100%', height: 38 };
    const drawCountdown = nextDrawAt ? countdownShort(nextDrawAt, Date.now()) : null;
    const onEarn = (EARN_PAGES as string[]).includes(page);
    return (
      <>
        {(lotteryEnabled || icpLpEnabled) && (
          <Eyebrow style={{ margin: '14px 0 4px' }}>Featured</Eyebrow>
        )}
        {lotteryEnabled && (
          <Btn variant={page === 'lottery' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('lottery')}>
            <Icon name="ticket" size={14} stroke={page === 'lottery' ? 'var(--char-950)' : 'currentColor'} />
            No-Loss Lottery
            {drawCountdown && (
              <Chip tone="muted" style={{
                marginLeft: 'auto', height: 18, fontSize: 10,
                // The muted chip uses var(--fg-2) text, which collapses on the
                // burn-orange primary fill when this nav item is selected.
                // Drop to near-black on a translucent dark pill so the countdown
                // stays readable against the orange.
                ...(page === 'lottery' ? {
                  color: 'var(--char-950)',
                  background: 'color-mix(in srgb, var(--char-950) 14%, transparent)',
                  borderColor: 'color-mix(in srgb, var(--char-950) 30%, transparent)',
                } : {}),
              }}>{drawCountdown}</Chip>
            )}
          </Btn>
        )}

        {/* ── Task 4 Tickets: staking + LP rewards ── */}
        {(losslessEnabled || earlyAdoptersEnabled || icpLpEnabled) && (
          <Eyebrow style={{ margin: '14px 0 4px' }}>Task 4 Tickets</Eyebrow>
        )}
        {(losslessEnabled || earlyAdoptersEnabled) && (
          <Btn variant={page === 'neuronstake' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('neuronstake')}>
            <Icon name="zap" size={14} stroke={page === 'neuronstake' ? 'var(--char-950)' : 'currentColor'} />
            Stake
          </Btn>
        )}
        {icpLpEnabled && (
          <Btn variant={page === 'icplp' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('icplp')}>
            <Icon name="stack" size={14} stroke={page === 'icplp' ? 'var(--char-950)' : 'currentColor'} />
            Liquidity Provider
          </Btn>
        )}
        {/* ── Listings: the voucher secondary market ── */}
        {vouchersEnabled && (
          <Eyebrow style={{ margin: '14px 0 4px' }}>Listings</Eyebrow>
        )}
        {vouchersEnabled && (
          <Btn variant={page === 'exchange' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('exchange')}>
            <Icon name="scale" size={14} stroke={page === 'exchange' ? 'var(--char-950)' : 'currentColor'} />
            Bond Exchange
          </Btn>
        )}

        {/* ── Play 4 Tickets: skill games with staker competitions ── */}
        {(luckproofEnabled || dropzoneEnabled || minigolfEnabled || bullrunEnabled) && (
          <Eyebrow style={{ margin: '14px 0 4px' }}>Play 4 Tickets</Eyebrow>
        )}
        {luckproofEnabled && (
          <Btn variant={page === 'luckproof' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('luckproof')}>
            <Icon name="pokerchip" size={14} stroke={page === 'luckproof' ? 'var(--char-950)' : 'currentColor'} />
            Luck-Proof
          </Btn>
        )}
        {dropzoneEnabled && (
          <Btn variant={page === 'dropzone' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('dropzone')}>
            <Icon name="parachute" size={14} stroke={page === 'dropzone' ? 'var(--char-950)' : 'currentColor'} />
            Drop Zone
          </Btn>
        )}
        {bullrunEnabled && (
          <Btn variant={page === 'bullrun' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('bullrun')}>
            <Icon name="bull" size={14} stroke={page === 'bullrun' ? 'var(--char-950)' : 'currentColor'} />
            Bull Run
          </Btn>
        )}
        {minigolfEnabled && (
          <Btn variant={page === 'minigolf' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('minigolf')}>
            <Icon name="golf" size={14} stroke={page === 'minigolf' ? 'var(--char-950)' : 'currentColor'} />
            Mini Golf
          </Btn>
        )}

        {govNavEnabled && (
          <>
            <Eyebrow style={{ margin: '14px 0 4px' }}>Governance</Eyebrow>
            <Btn variant={page === 'voting' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('voting')}>
              <Icon name="scale" size={14} stroke={page === 'voting' ? 'var(--char-950)' : 'currentColor'} />
              Voting
            </Btn>
            <Btn variant={onEarn ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('earn')}>
              <Icon name="coins" size={14} stroke={onEarn ? 'var(--char-950)' : 'currentColor'} />
              Neuron Syndicate
            </Btn>
          </>
        )}


        {/* ── Admin: the console's sections, visible to admins only ── */}
        {isAdmin && (
          <>
            <Eyebrow style={{ margin: '14px 0 4px' }}>Admin</Eyebrow>
            <Btn variant={page === 'admin_money' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin_money')}>
              <Icon name="wallet" size={14} stroke={page === 'admin_money' ? 'var(--char-950)' : 'currentColor'} />
              Money
            </Btn>
            <Btn variant={page === 'admin_economics' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin_economics')}>
              <Icon name="coins" size={14} stroke={page === 'admin_economics' ? 'var(--char-950)' : 'currentColor'} />
              Economics
            </Btn>
            <Btn variant={page === 'admin_neurons' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin_neurons')}>
              <Icon name="coins" size={14} stroke={page === 'admin_neurons' ? 'var(--char-950)' : 'currentColor'} />
              Neurons
            </Btn>
            <Btn variant={page === 'admin_users' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin_users')}>
              <Icon name="list" size={14} stroke={page === 'admin_users' ? 'var(--char-950)' : 'currentColor'} />
              Users
            </Btn>
            <Btn variant={page === 'admin_system' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin_system')}>
              <Icon name="info" size={14} stroke={page === 'admin_system' ? 'var(--char-950)' : 'currentColor'} />
              System
            </Btn>
            <Btn variant={page === 'admin_reference' ? 'primary' : 'ghost'} style={linkStyle} onClick={() => go('admin_reference')}>
              <Icon name="bulb" size={14} stroke={page === 'admin_reference' ? 'var(--char-950)' : 'currentColor'} />
              How it works
            </Btn>
          </>
        )}

      </>
    );
  };

  // Shared side-navigation body — identical in the persistent desktop sidebar
  // and the mobile drawer. `onNavigate` closes the mobile drawer (no-op on
  // desktop). Navigation up top; Socials pinned to the bottom. There is no
  // Account section — the Wallet button (top bar) opens the Profile page,
  // the Admin console is its own admin-only nav group, and Sign out lives
  // on the Profile page header. Sign in lives in the top bar.
  const renderDrawerBody = (onNavigate?: () => void) => (
    <>
      <div className="col" style={{ gap: 8, width: '100%', marginBottom: 32 }}>
        {renderNavLinks(onNavigate)}
      </div>

      <div className="col" style={{ gap: 8, width: '100%', marginTop: 'auto' }}>
        <Eyebrow style={{ marginBottom: 6 }}>Socials</Eyebrow>
        <a
          href={DISCORD_INVITE} target="_blank" rel="noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none',
            color: 'var(--fg)', fontSize: 13.5, fontWeight: 500, marginBottom: 8,
            padding: '0 0 0 2px',
          }}
        >
          <DiscordMark size={17} color="#5865F2" /> Join the ICP Dapp Factory
        </a>
        <button
          onClick={() => setPage('devdocs')}
          style={{
            display: 'flex', alignItems: 'center', gap: 9, background: 'transparent',
            border: 'none', cursor: 'pointer', textAlign: 'left',
            color: 'var(--fg)', fontSize: 13.5, fontWeight: 500, marginBottom: 8,
            padding: '0 0 0 2px',
          }}
        >
          <Icon name="edit" size={15} stroke="var(--fg-2)" /> Developer docs
        </button>
        <a
          href={OPENCHAT_URL} target="_blank" rel="noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none',
            color: 'var(--fg)', fontSize: 13.5, fontWeight: 500, marginBottom: 8,
            padding: '0 0 0 2px',
          }}
        >
          <OpenChatMark size={15} color="#FF8541" /> Chat on OpenChat
        </a>
        <a
          href="https://x.com/CalderaICP" target="_blank" rel="noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none',
            color: 'var(--fg)', fontSize: 13.5, fontWeight: 500, marginBottom: 8,
            padding: '0 0 0 2px',
          }}
        >
          <svg width={15} height={15} viewBox="0 0 1200 1227" fill="currentColor" style={{ flexShrink: 0 }} aria-hidden="true">
            <path d="M714.163 519.284 1160.89 0h-105.86L667.137 450.887 357.328 0H0l468.492 681.821L0 1226.37h105.866l409.625-476.152 327.181 476.152H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894-377.686-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z"/>
          </svg>
          Follow on X
        </a>
      </div>
    </>
  );

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
  // When the treasury can't front the ledger fees a commit/top-up needs at
  // settlement/refund, the backend refuses those actions — so the UI hides them
  // too. Fail-open while stats are still loading (the backend still enforces).
  const treasuryCanFront = globalStats?.treasury_can_front_fees ?? true;

  // Past Proposals only lists proposals whose burn threshold was actually met.
  // Threshold-missed proposals returned every commitment and nothing was burned,
  // so they're omitted entirely (per observations.md).
  const icpRateUsdForHistory = usdRates[ExplorerToken.ICP] ?? 0n;
  const pastItems: { id: bigint; proposal?: Proposal; record?: VoteRecord }[] = [];
  historyProposals.forEach(p => {
    if (!proposalThresholdMet(p, icpRateUsdForHistory)) return;
    pastItems.push({ id: BigInt(p.id), proposal: p });
  });
  nonCommitVotes.forEach(r => {
    // Following-only vote records with nothing burned mean the threshold missed.
    if (r.icp_burned_e8s === 0n) return;
    pastItems.push({ id: BigInt(r.proposal_id), record: r });
  });
  pastItems.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  // Past Proposals: cap to the latest 250, shown 50 per page.
  const HISTORY_PER_PAGE = 50;
  const cappedPast = pastItems.slice(0, 250);
  const totalHistoryPages = Math.max(1, Math.ceil(cappedPast.length / HISTORY_PER_PAGE));
  const safeHistoryPage = Math.min(historyPage, totalHistoryPages - 1);
  const displayedPastItems = cappedPast.slice(
    safeHistoryPage * HISTORY_PER_PAGE,
    safeHistoryPage * HISTORY_PER_PAGE + HISTORY_PER_PAGE,
  );

  // First contact: the landing page renders full-bleed with no app chrome.
  // "Go to App" heads for the lottery; anonymous visitors bounce off the
  // auth gate (#/auth) on the way and land there after signing in.
  if (page === 'landing') {
    return (
      <Landing
        // Anonymous actor for the landing's live lottery reads (pot, countdown,
        // winners, total staked) — all anonymous-allowlisted queries.
        actor={actor}
        // Only gate sections once flags have actually loaded; before that show
        // everything (passing undefined → Landing's default-safe fallback),
        // otherwise the not-yet-loaded flags hide every flagged section.
        flags={featureFlags.length > 0 ? {
          staking: losslessEnabled,
          lottery: lotteryEnabled,
        } : undefined}
        onEnter={() => {
          window.scrollTo(0, 0);
          setPage('lottery');
        }}
      />
    );
  }

  // The Golden Ticket claim page is a standalone campaign surface (like the
  // landing): full-bleed, reachable signed-out, no app chrome.
  if (page === 'claim') {
    return (
      <ClaimPromo
        actor={actor}
        principal={principal}
        onSignIn={handleLogin}
        onEnter={() => { window.scrollTo(0, 0); setPage('lottery'); }}
      />
    );
  }

  // The sign-in gate — standalone full-bleed page, no app chrome.
  if (page === 'auth') {
    return (
      <AuthGate
        onSignIn={handleLogin}
        isSigningIn={isSigningIn}
        onGoLanding={() => redirect('landing')}
      />
    );
  }

  // Every page from here on is members-only. While AuthClient is still
  // resolving (principal === null) — or on the single paint before the gate
  // effect bounces an anonymous visitor to #/auth — render a neutral shell
  // instead of the page, so in-app pages NEVER mount signed-out and carry no
  // signed-out UI states.
  if (!principal || principal.isAnonymous()) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'var(--bg)', color: 'var(--fg-3)', fontSize: 14 }}>
        <LiveDot size={8} /> Loading…
      </div>
    );
  }

  return (
    <DevControlsContext.Provider value={setPageDevControls}>
    <PageHelpContext.Provider value={setPageHelp}>
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
          <span className="row" style={{ gap: 10, minWidth: 0 }}>
            <BrandMark size={26} style={{ flexShrink: 0 }} />
            <b className="app-header-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Cycle Burn
            </b>
          </span>

        </div>

        <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0, position: 'relative' }}>
          {/* Bookmark — reveals the keyboard shortcut (browsers block scripted
              bookmarking) and copies the app URL as a fallback. Desktop only. */}
          <button
            className="hide-mobile"
            onClick={handleBookmark}
            aria-label="Bookmark this app"
            title="Bookmark Cycle Burn"
            style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 8,
              cursor: 'pointer', color: 'var(--fg-2)', padding: 7,
              alignItems: 'center', flexShrink: 0,
            }}
          >
            <Icon name="star" size={16} fill={bookmarkHint ? 'var(--burn-ink)' : 'none'} stroke={bookmarkHint ? 'var(--burn-ink)' : 'currentColor'} />
          </button>
          {bookmarkHint && (
            <div role="status" style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 50,
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '8px 11px', boxShadow: '0 6px 20px rgba(0,0,0,0.18)', width: 'max-content', maxWidth: 240,
            }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-1)' }}>
                Press <b className="mono" style={{ color: 'var(--burn-ink)' }}>{bookmarkShortcut}</b> to bookmark Cycle Burn.
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fg-3)', marginTop: 3 }}>
                Link copied to your clipboard too.
              </span>
            </div>
          )}

          {/* Theme toggle — sun in dark mode (tap for light), moon in light mode */}
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 8,
              cursor: 'pointer', color: 'var(--fg-2)', padding: 7, display: 'flex',
              alignItems: 'center', flexShrink: 0,
            }}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>

          {/* Wallet affordance in the top bar — reachable on every page. The
              app chrome only ever renders signed-in (the #/auth gate owns
              sign-in); sign out lives on the Profile page header. */}
          <button
            onClick={() => { setPage('payouts'); setWalletRequest(n => n + 1); }}
            title="Open your wallet"
            style={{
              background: 'var(--burn)', border: '1px solid var(--burn)', borderRadius: 8,
              cursor: 'pointer', color: 'var(--char-950)',
              padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 12.5, fontWeight: 600, flexShrink: 0,
            }}
          >
            <Icon name="wallet" size={14} stroke="var(--char-950)" /> Wallet
          </button>
        </div>
      </header>

      {/* ── Main Layout (Nav Sidebar + Content + Tweak Panel) ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* Persistent navigation drawer — always open on desktop; the mobile
            drawer (overlay) carries the same links below 900px. */}
        <aside className="hide-mobile col" style={{
          width: 248, flexShrink: 0, gap: 0, padding: '18px 16px',
          borderRight: '1px solid var(--border)', overflowY: 'auto',
        }}>
          {renderDrawerBody()}
        </aside>

        {/* Content column. Keyed by page so every page fades/blurs in with the
            expressive transition on navigation. */}
        <main ref={mainScrollRef} style={{ flex: 1, minWidth: 320, overflowY: 'auto' }}>
          {/* Mobile: a fixed "How it works" tab on the right edge → full-
              screen modal (desktop uses the persistent right panel). */}
          <PageHelpMobile>{pageHelp}</PageHelpMobile>
          {winBanner && (
            <div role="status" style={{
              display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between',
              margin: '12px 16px 0', padding: '12px 16px', borderRadius: 12,
              background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))',
              border: '1px solid var(--burn)', color: 'var(--fg)',
            }}>
              <span className="row" style={{ gap: 10, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
                <Icon name="spark" size={18} stroke="var(--burn-ink)" />
                <span style={{ fontSize: 13.5 }}>
                  🎉 You won the lottery! <b className="mono" style={{ color: 'var(--sprout-ink)' }}>{fmtICP(winBanner.prize)} ICP</b> was paid straight to your wallet.
                  <button onClick={() => setPage('lottery')} style={{ background: 'none', border: 'none', color: 'var(--burn-ink)', cursor: 'pointer', textDecoration: 'underline', padding: 0, marginLeft: 6, fontSize: 13.5 }}>View drawing</button>
                </span>
              </span>
              <button onClick={dismissWinBanner} title="Dismiss" aria-label="Dismiss win banner"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 2, flexShrink: 0 }}>
                <Icon name="x" size={16} />
              </button>
            </div>
          )}
          <Reveal key={page} motion={motion} style={{ display: 'block', minHeight: '100%' }}>
          {(EARN_PAGES as string[]).includes(page) ? (
            <div className="col" style={{ minHeight: '100%' }}>
              {/* ── Neuron Syndicate (the Earn page is now a single view) ── */}
              {
                <div className="idea-board-container" style={{ paddingTop: 18 }}>
                  {/* ── Page header (eyebrow · title · how it works) — Explorer style ── */}
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
                    <div className="col" style={{ gap: 6 }}>
                      <Eyebrow accent>Govern with the community</Eyebrow>
                      <span className="row" style={{ gap: 10, alignItems: 'center' }}>
                        <NeuronGlyph size={22} />
                        <h4 style={{ margin: 0 }}>Neuron Syndicate</h4>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                          {poolInfo?.active_count.toString() ?? '0'} active
                        </span>
                      </span>
                      <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
                        <b style={{ color: 'var(--sprout-ink)' }}>Earn ICP just for pooling your voting power.</b> A share of every protocol burn is split among verified members and paid out in ICP — your neuron keeps working for you with nothing to lock up or spend. To qualify, set your NNS neuron to follow the leader neuron and verify it here; as long as it keeps following, you keep earning from every burn.{' '}
                        <button type="button" onClick={() => setPoolDetailsOpen(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--burn-ink)', fontSize: 12, textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
                          <Icon name="info" size={11} stroke="var(--burn-ink)" /> How it works
                        </button>
                      </p>
                    </div>
                  </div>

                  {!myPoolNeuron && principal && !principal.isAnonymous() && (
                    <Btn
                      variant="primary"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => openPoolWizard()}
                    >
                      <Icon name="spark" size={14} stroke="var(--char-950)" />
                      Join Pool
                    </Btn>
                  )}

                  {/* Member neuron cards — Staking term-pool card format, laid
                      out in the same 3-up grid the other pages use. */}
                  <div className="idea-grid">
                    {myPoolNeuron && (
                      <div className="col" style={{
                        gap: 10, padding: '14px 16px', borderRadius: 10, minWidth: 0,
                        border: '1px solid var(--border-hi)',
                        background: 'color-mix(in srgb, var(--burn) 14%, transparent)',
                      }}>
                        <div className="col" style={{ gap: 6 }}>
                          <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                            {poolIs(myPoolNeuron.status, 'Active')
                              ? (myPoolRank != null
                                  ? <Chip tone={myPoolRank <= 100 ? 'ok' : 'muted'}>Rank {myPoolRank}</Chip>
                                  : <Chip tone="muted">Active</Chip>)
                              : poolIs(myPoolNeuron.status, 'Draft')
                              ? <Chip tone="pending">Draft</Chip>
                              : <Chip tone="muted">Inactive</Chip>}
                            <Chip tone="muted">You</Chip>
                          </span>
                          {isLocal ? (
                            <b className="mono" style={{ fontSize: 14.5, overflowWrap: 'anywhere' }}>#{myPoolNeuron.neuron_id.toString()}</b>
                          ) : (
                            <a className="mono"
                              href={`https://dashboard.internetcomputer.org/neuron/${myPoolNeuron.neuron_id.toString()}`}
                              target="_blank" rel="noreferrer"
                              style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--fg)', textDecoration: 'none', overflowWrap: 'anywhere', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                              title="View this neuron on the NNS dashboard"
                            >
                              #{myPoolNeuron.neuron_id.toString()} <Icon name="external" size={12} stroke="var(--fg-3)" />
                            </a>
                          )}
                        </div>
                        {poolIs(myPoolNeuron.status, 'Active') && (
                          <div className="col" style={{ gap: 7, fontSize: 12.5, minWidth: 0 }}>
                            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ color: 'var(--fg-3)' }}>Voting power</span>
                              <span className="mono" style={{ color: 'var(--sprout-ink)' }}>{fmtVP(myPoolNeuron.voting_power)} VP</span>
                            </div>
                            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                              Registered {new Date(Number((myPoolNeuron.activated_at ?? myPoolNeuron.created_at) / 1_000_000n)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          </div>
                        )}
                        {(poolIs(myPoolNeuron.status, 'Draft') || poolIs(myPoolNeuron.status, 'Inactive')) && (
                          <Btn variant="primary" sm style={{ alignSelf: 'flex-start' }} onClick={() => openPoolWizard()}>
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
                        <div key={n.neuron_id.toString()} className="card col" style={{ gap: 8, minWidth: 0 }}>
                          <div className="col" style={{ gap: 6 }}>
                            <Chip tone={n.rank <= 100 ? 'ok' : 'muted'} style={{ alignSelf: 'flex-start' }}>Rank {n.rank}</Chip>
                            {isLocal ? (
                              <b className="mono" style={{ fontSize: 14.5, overflowWrap: 'anywhere' }}>#{n.neuron_id.toString()}</b>
                            ) : (
                              <a className="mono"
                                href={`https://dashboard.internetcomputer.org/neuron/${n.neuron_id.toString()}`}
                                target="_blank" rel="noreferrer"
                                style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--fg)', textDecoration: 'none', overflowWrap: 'anywhere', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                                title="View this neuron on the NNS dashboard"
                              >
                                #{n.neuron_id.toString()} <Icon name="external" size={12} stroke="var(--fg-3)" />
                              </a>
                            )}
                          </div>
                          <div className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                            <span style={{ color: 'var(--fg-3)' }}>Voting power</span>
                            <span className="mono" style={{ color: 'var(--sprout-ink)' }}>{fmtVP(n.voting_power)} VP</span>
                          </div>
                          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                            Registered {new Date(Number(n.registered_at / 1_000_000n)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </div>
                      ))}
                  </div>

                  {(poolInfo?.active_count ?? 0n) === 0n && !myPoolNeuron && (
                    <span style={{ fontSize: 13, color: 'var(--fg-3)', padding: '12px 0', lineHeight: 1.6 }}>
                      No Neuron Syndicate members yet. Verify your neuron to start earning a share of every burn.
                    </span>
                  )}
                </div>
              }
            </div>
          ) : page === 'lottery' ? (
            <LotteryHub
              actor={actor}
              identity={identity}
              principal={principal}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
              isLocal={config?.is_local ?? false}
              onGoNeuronStake={() => setPage('neuronstake')}
              onGoExchange={() => setPage('exchange')}
              onGoLiquidity={() => setPage('icplp')}
            />
          ) : page === 'devdocs' ? (
            <DevDocs />
          ) : page === 'exchange' && vouchersEnabled ? (
            <VoucherExchange
              actor={actor}
              identity={identity}
              principal={principal}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
            />
          ) : page === 'neuronstake' && (losslessEnabled || earlyAdoptersEnabled) ? (
            <NeuronStakePage
              actor={actor}
              identity={identity}
              principal={principal}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
              isLocal={config?.is_local ?? false}
              boostersEnabled={earlyAdoptersEnabled}
              isAdmin={isAdmin}
              treasuryCanFront={globalStats?.treasury_can_front_fees ?? true}
              onActivity={refreshAllData}
              onGoExchange={() => setPage('exchange')}
              onGoLiquidity={() => setPage('icplp')}
            />
          ) : page === 'icplp' && icpLpEnabled ? (
            <IcpLp
              actor={actor}
              onGoParticipate={() => setPage(losslessEnabled ? 'neuronstake' : 'voting')}
            />
          ) : page === 'luckproof' && luckproofEnabled ? (
            <LuckProofPage
              actor={actor}
              onGoParticipate={() => setPage(losslessEnabled ? 'neuronstake' : 'voting')}
            />
          ) : page === 'dropzone' && dropzoneEnabled ? (
            <DropZonePage
              actor={actor}
              onGoParticipate={() => setPage(losslessEnabled ? 'neuronstake' : 'voting')}
              isLocal={config?.is_local ?? false}
            />
          ) : page === 'bullrun' && bullrunEnabled ? (
            <BullRunPage
              actor={actor}
              onGoParticipate={() => setPage(losslessEnabled ? 'neuronstake' : 'voting')}
              isLocal={config?.is_local ?? false}
            />
          ) : page === 'minigolf' && minigolfEnabled ? (
            <MiniGolfPage
              actor={actor}
              identity={identity}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
              backendCanisterId={backendCanisterId}
              isLocal={config?.is_local ?? false}
              onGoParticipate={() => setPage(losslessEnabled ? 'neuronstake' : 'voting')}
            />
          ) : page === 'payouts' ? (
            <Payouts
              key={walletRequest}
              actor={actor}
              principal={principal}
              identity={identity}
              host={host}
              rootKey={env?.IC_ROOT_KEY}
              ledgerCanisterId={ledgerCanisterId}
              isLocal={config?.is_local ?? false}
              onSignOut={handleLogout}
            />
          ) : page === 'admin_money' || page === 'admin_economics' || page === 'admin_neurons' || page === 'admin_users' || page === 'admin_system' || page === 'admin_reference' ? (
            isAdmin ? (
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
                section={page === 'admin_money' ? 'money' : page === 'admin_economics' ? 'economics' : page === 'admin_neurons' ? 'neurons' : page === 'admin_users' ? 'users' : page === 'admin_system' ? 'system' : 'reference'}
              />
            ) : (
              /* Auth/config still resolving (confirmed non-admins are bounced
                 by the guard effect) — show a quiet loading state. */
              <div className="dashboard-container" style={{ alignItems: 'center', paddingTop: 80 }}>
                <LiveDot size={10} color="var(--burn-ink)" />
              </div>
            )
          ) : (
          <div className="idea-board-container">

            {/* ── Your activity (Tier 3) — PRIMARY, prominent ──
                Personal stats matter more than site-wide totals, so when the
                user has activity this renders first as the bold hero strip. */}
            {tier >= 3 && (
              <Reveal delay={30} motion={motion}>
                <div className="col" style={{ gap: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <Icon name="wallet" size={13} stroke="var(--burn-ink)" />
                    <Eyebrow>Your activity</Eyebrow>
                  </div>
                  <div className="row" data-testid="user-stats-strip" style={{
                    border: '1px solid var(--burn)', borderRadius: 12, background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))',
                    padding: '18px 8px', boxShadow: '0 0 0 1px color-mix(in srgb, var(--burn) 25%, transparent)'
                  }}>
                    <div className="col" style={{ gap: 4, flex: 1, alignItems: 'center', textAlign: 'center' }}>
                      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <Icon name="coins" size={16} stroke="var(--burn-ink)" />
                        <span className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                          {fmtICP(totalCommitted)} ICP
                        </span>
                      </span>
                      <Eyrow>Committed</Eyrow>
                      {userPendingBurn > 0n && (
                        <span className="mono" style={{ fontSize: 11, color: 'var(--haze-ink)', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }} title="ICP committed to proposals that reached their threshold and will burn on deadline">
                          <Icon name="clock" size={11} stroke="var(--haze-ink)" /> {fmtICP(userPendingBurn)} pending
                        </span>
                      )}
                    </div>
                    <div className="col" style={{
                      gap: 4, flex: 1, alignItems: 'center', textAlign: 'center',
                      borderLeft: '1px solid color-mix(in srgb, var(--burn) 28%, transparent)'
                    }}>
                      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <Icon name="flame" size={16} stroke="var(--burn-ink)" />
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
                        <Icon name="checkCircle" size={16} stroke="var(--burn-ink)" />
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

            {/* ── Tagline ── */}
            <Reveal delay={50} motion={motion}>
              <div className="col" style={{ gap: 10 }}>
                <div className="col" style={{ gap: 6 }}>
                  <Eyebrow accent>NNS governance</Eyebrow>
                  <span className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <Icon name="scale" size={22} stroke="var(--burn-ink)" />
                    <h4 style={{ margin: 0 }}>Use our voting power</h4>
                  </span>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
                    Burn ICP to steer the NNS proposals you care about — your conviction decides
                    which way the community neuron votes.{' '}
                    <MoreInfo title="How burn voting works">
                      <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                        <Eyebrow accent>The gist</Eyebrow>
                        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                          Committing ICP <b>temporarily borrows the community leader neuron's voting power</b>.
                          The heavier side — adopt vs reject — decides how the neuron votes.
                        </p>
                      </div>
                      <div className="col" style={{ gap: 6 }}>
                        <Eyebrow accent>How your weight counts</Eyebrow>
                        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                          <li><b>More commit = more weight:</b> your ICP adds to your side's total.</li>
                          <li><b>Adopt vs reject face off:</b> the heavier side decides the neuron's vote.</li>
                        </ul>
                      </div>
                      <div className="col" style={{ gap: 6 }}>
                        <Eyebrow accent>What happens to your ICP</Eyebrow>
                        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                          <li><b>Escrowed</b> until the proposal's deadline.</li>
                          <li><b>Threshold met &amp; neuron votes →</b> your commitment is spent (burned).</li>
                          <li><b>Threshold not met →</b> returned in full. No fees either way.</li>
                        </ul>
                      </div>
                    </MoreInfo>
                  </p>
                </div>
                <div className="row" style={{ gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setIsDetailsOpen(true)}
                    style={{
                      background: 'transparent', border: 'none', color: 'var(--burn-ink)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                      padding: 0, fontSize: 13.5, fontWeight: 500, width: 'fit-content',
                      transition: 'opacity 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                  >
                    <Icon name="info" size={13} stroke="var(--burn-ink)" />
                    More details
                  </button>
                </div>
              </div>
            </Reveal>

            {/* ── PB-071: Neuron Identity Block — staking-card style ── */}
            <Reveal delay={70} motion={motion}>
              <div className="card col" style={{ gap: 12 }}>
                <div className="col" style={{ gap: 6 }}>
                  <Chip tone="ok" style={{ height: 22, alignSelf: 'flex-start' }}>
                    <Icon name="zap" size={12} /> {leaderInfo && totalSyndicateVP > 0n ? `${fmtVP(totalSyndicateVP)} VP` : '… VP'}
                  </Chip>
                  <b style={{ fontSize: 14.5 }}>Syndicate Voting Power</b>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                    Rent voting power from a pool of neurons to multiply your influence on every vote — no ICP lock-up required.
                  </span>
                </div>

                <div className="row" style={{
                  justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 10,
                  borderTop: '1px solid var(--border)', marginTop: 1
                }}>
                  <Btn variant="secondary" sm onClick={() => setPage('earn')}>
                    <Icon name="coins" size={13} /> Join the Neuron Syndicate
                  </Btn>
                  {!isFollowing ? (
                    <Btn variant="primary" sm onClick={() => { setNnsOpened(false); setIsFollowModalOpen(true); }}>
                      <Icon name="checkCircle" size={13} stroke="var(--char-950)" /> Follow neuron
                    </Btn>
                  ) : (
                    <span className="row" style={{ gap: 6, color: 'var(--sprout-ink)', fontSize: 12.5 }}>
                      <Icon name="checkCircle" size={13} stroke="var(--sprout-ink)" /> Following
                    </span>
                  )}
                </div>
              </div>
            </Reveal>

            {/* ── Three-section proposal list ── */}
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-3)' }}>
                <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
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
                        color: activeTab === 'open' ? 'var(--burn-ink)' : 'var(--fg-3)',
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
                          color: activeTab === 'committed' ? 'var(--burn-ink)' : 'var(--fg-3)',
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
                        color: activeTab === 'history' ? 'var(--burn-ink)' : 'var(--fg-3)',
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
                          <LiveDot on={motion !== 'off'} color="var(--sprout-ink)" size={7} />
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
                      const proposalIdStr = p.id.toString();
                      const aiReview = aiReviews[proposalIdStr];
                      const aiOpen = aiOpenMap[proposalIdStr] || (aiMode === 'expanded' && i === 0);

                      const { pct, reqSuffix } = thresholdProgress(p, usdRates[ExplorerToken.ICP] ?? 0n);
                      const met = p.status === 'met' || pct >= 100;

                      const committedLabel = `${fmtICP(p.total_committed_e8s)} ICP committed`;
                      const reqLabel = pct > 100 ? `${pct}% · oversubscribed` : met ? `${pct}% · met` : `${pct}% ${reqSuffix}`;

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
                          To flip to <strong style={{ color: flipInfo.toStance === 'Adopt' ? 'var(--sprout-ink)' : 'var(--ember)', fontWeight: 600 }}>{flipInfo.toStance.toUpperCase()}</strong>: <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtFlipAmount(flipInfo.amountE8s)} ICP</span>
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
                            <><Icon name="flame" size={11} stroke="var(--burn-ink)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP Spent</>
                          ) : myCommitment.status === CommitmentStatus.Returned ? (
                            <><Icon name="checkCircle" size={11} stroke="var(--sprout-ink)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP Returned</>
                          ) : (myCommitment.status === CommitmentStatus.FailedBurn || myCommitment.status === CommitmentStatus.FailedRefund) ? (
                            <><Icon name="x" size={11} /> Settlement error — retrying</>
                          ) : met ? (
                            <><Icon name="flame" size={11} stroke="var(--burn-ink)" /> You · {fmtICP(myCommitment.amount_e8s)} ICP burning soon</>
                          ) : (
                            <>You · {fmtICP(myCommitment.amount_e8s)} ICP pending ({myCommitment.stance === Stance.Adopt ? "ADOPT" : "REJECT"})</>
                          )}
                        </Chip>
                      );

                      return (
                        <Reveal key={proposalIdStr} delay={120 + i * 70} motion={motion}>
                          <div id={`proposal-card-${(p.nns_proposal_id ?? p.id).toString()}`} className="col" style={{
                            gap: 12, border: `1px solid ${met ? 'var(--sprout)' : 'var(--border)'}`,
                            borderRadius: 8, background: 'var(--surface)', padding: 14,
                            transition: 'box-shadow 0.6s var(--ease-out)'
                          }}>
                            {/* Title and stats header */}
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                              <div className="col" style={{ gap: 7, minWidth: 0, flex: 1 }}>
                                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <Chip tone="muted" style={{ height: 20, fontSize: 11 }}>{p.category}</Chip>
                                  <a href={nnsProposalLink(p)} target="_blank" rel="noreferrer" className="mono" style={{
                                    fontSize: 11, color: 'var(--burn-ink)', whiteSpace: 'nowrap', textDecoration: 'underline'
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
                                {statusChip}
                                {flipLabel}
                              </div>
                            </div>

                            {/* Balance of power + burn progress. Voting is
                                burn-only — the bar and threshold both reflect
                                burned ICP. */}
                            <div className="col" style={{ gap: 10 }}>
                              <BalanceOfPowerBar
                                adopt={p.adopt_pot_e8s}
                                reject={p.reject_pot_e8s}
                              />
                              <HeatBar pct={pct} committed={committedLabel} req={reqLabel} met={met} />
                            </div>

                            {/* Action zone */}
                            <div style={{ borderTop: '1px solid var(--border)' }} />

                            {(
                              <div className="col" style={{ gap: 10 }}>
                                {treasuryCanFront ? (
                                <div className="row" style={{ gap: 8 }}>
                                  <Btn
                                    variant="primary"
                                    sm
                                    style={{ flex: 1, background: 'var(--sprout-dim)', color: 'var(--sprout-ink)', border: '1px solid var(--sprout)' }}
                                    onClick={() => handleCommitClick(p.id, Stance.Adopt)}
                                  >
                                    <Icon name="checkCircle" size={13} stroke="var(--sprout-ink)" /> ADOPT
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
                                ) : (
                                  <div className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--haze-ink)', padding: '6px 8px', borderRadius: 6, background: 'var(--haze-dim)', border: '1px solid var(--haze)' }}>
                                    <Icon name="info" size={12} stroke="var(--haze-ink)" />
                                    Voting is paused — the treasury can't currently cover the ledger fees a commitment needs. Try again shortly.
                                  </div>
                                )}

                                {mineBadge && (
                                  <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                                    {mineBadge}
                                  </div>
                                )}

                                {/* AI Review Panel */}
                                {aiReview && aiMode !== 'hidden' && (
                                  <AIPanel
                                    open={aiOpen}
                                    onToggle={() => setAiOpenMap({ ...aiOpenMap, [proposalIdStr]: !aiOpen })}
                                    score={aiReview.score}
                                    text={aiReview.text}
                                  />
                                )}

                              </div>
                            )}
                            {/* Footer: Share (bottom-left) · Discussion (bottom-right) */}
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                              <button onClick={() => shareProposalOnX(p)} title="Share this proposal on X" style={{
                                background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, fontSize: 11,
                              }}>
                                <Icon name="share" size={12} /> Share
                              </button>
                              <span />
                            </div>
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
                          <Icon name="flame" size={13} stroke="var(--burn-ink)" />
                          <b style={{ fontSize: 14, color: 'var(--fg)' }}>Committed</b>
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {committedProposals.length}</span>
                        </span>
                        <Eyebrow style={{ whiteSpace: 'nowrap' }}>your active stake</Eyebrow>
                      </div>
                    </Reveal>
                    {committedProposals.length === 0 ? (
                      <div style={{ padding: '12px 0', color: 'var(--fg-3)', fontSize: 13 }}>No active commitments yet.</div>
                    ) : committedProposals.map(p => {
                      const myCommitment = myCommitments.find(c => c.proposal_id === p.id);
                      const { pct } = thresholdProgress(p, usdRates[ExplorerToken.ICP] ?? 0n);
                      const met = p.status === 'met' || pct >= 100;
                      const remainingNs = Number(p.deadline) - Date.now() * 1_000_000;
                      const remainingH = Math.max(0, Math.floor(remainingNs / (3600 * 1_000_000_000)));
                      const remainingD = Math.floor(remainingH / 24);
                      const deadlineStr = remainingD > 0 ? `${remainingD}d ${remainingH % 24}h` : `${remainingH}h`;
                      const isRetrying = myCommitment?.status === CommitmentStatus.FailedBurn || myCommitment?.status === CommitmentStatus.FailedRefund;
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
                          To flip to <strong style={{ color: flipInfo.toStance === 'Adopt' ? 'var(--sprout-ink)' : 'var(--ember)', fontWeight: 600 }}>{flipInfo.toStance.toUpperCase()}</strong>: <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtFlipAmount(flipInfo.amountE8s)} ICP</span>
                        </span>
                      );
                      return (
                        <Reveal key={p.id.toString()} delay={140} motion={motion}>
                          {/* Same anchor id as the active card — the tabs
                              mount exclusively, so the id never duplicates,
                              and share links to committed proposals can
                              scroll/highlight too. */}
                          <div id={`proposal-card-${(p.nns_proposal_id ?? p.id).toString()}`} className="col" style={{
                            gap: 10, border: `1px solid ${met ? 'var(--burn)' : 'var(--border)'}`,
                            borderRadius: 8, background: 'var(--surface)', padding: 14,
                            transition: 'box-shadow 0.6s var(--ease-out)'
                          }}>
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                              <div className="col" style={{ gap: 7, minWidth: 0, flex: 1 }}>
                                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <Chip tone="muted" style={{ height: 18, fontSize: 10.5 }}>{p.category}</Chip>
                                  <a href={nnsProposalLink(p)} target="_blank" rel="noreferrer" className="mono" style={{
                                    fontSize: 11, color: 'var(--burn-ink)', whiteSpace: 'nowrap', textDecoration: 'underline'
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
                                  ? <Chip tone="burn"><Icon name="flame" size={11} stroke="var(--burn-ink)" /> Threshold met</Chip>
                                  : <Chip tone="muted"><LiveDot on={motion !== 'off'} /> Open</Chip>}
                                {flipLabel}
                              </div>
                            </div>
                            <BalanceOfPowerBar
                              adopt={p.adopt_pot_e8s}
                              reject={p.reject_pot_e8s}
                            />
                            <HeatBar pct={pct} committed={`${fmtICP(p.total_committed_e8s)} ICP`} req={met ? `${pct}% · met` : `${pct}% of ${fmtICP(p.threshold_e8s)} ICP`} met={met} />
                            <div style={{ borderTop: '1px solid var(--border)' }} />
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                              <span className="row" style={{ gap: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
                                {myCommitment && (
                                  <>
                                    <span style={{ color: 'var(--fg-3)' }}>Burned</span>
                                    <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtICP(myCommitment.amount_e8s)} ICP</span>
                                    <Chip tone={myCommitment.stance === Stance.Adopt ? 'ok' : 'danger'} style={{ height: 18, fontSize: 10.5 }}>
                                      {myCommitment.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'}
                                    </Chip>
                                  </>
                                )}
                              </span>
                              {isRetrying && (
                                <Chip tone="danger" style={{ fontSize: 11 }}><Icon name="x" size={10} /> Error — retrying</Chip>
                              )}
                              {!isRetrying && myCommitment?.status === CommitmentStatus.Pending
                                && (p.status === 'open' || p.status === 'met')
                                && remainingNs > 3_600_000_000_000
                                && treasuryCanFront && (
                                <button
                                  onClick={() => handleAddMoreClick(p.id)}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    color: 'var(--burn-ink)', fontSize: 11.5, padding: 0,
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
                                ? 'Threshold met — when the neuron votes, your committed ICP is burned.'
                                : 'If the threshold misses, your committed ICP is returned.'}
                            </span>
                            {/* Footer: Share (bottom-left) · Discussion (bottom-right) */}
                            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                              <button onClick={() => shareProposalOnX(p)} title="Share this proposal (and your stance) on X" style={{
                                background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, fontSize: 11,
                              }}>
                                <Icon name="share" size={12} /> Share
                              </button>
                              <span />
                            </div>
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
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {cappedPast.length}</span>
                        </span>
                      </div>
                    </Reveal>

                    {displayedPastItems.length === 0 ? (
                      <div style={{ padding: '12px 0', color: 'var(--fg-3)', fontSize: 13 }}>No settled proposals yet.</div>
                    ) : (
                      <>
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
                                    <span className="mono" style={{ color: isBurned ? 'var(--burn-ink)' : 'var(--sprout-ink)' }}>
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
                                  <Chip tone={record.vote === Vote.Yes ? 'ok' : 'muted'} style={{ height: 20, fontSize: 11 }}>{voteStr}</Chip>
                                  {record.icp_burned_e8s > 0n && (
                                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--burn-ink)' }}>{fmtICP(record.icp_burned_e8s)} spent</span>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                      {totalHistoryPages > 1 && (
                        <div className="row" style={{ justifyContent: 'center', alignItems: 'center', gap: 12, paddingTop: 12 }}>
                          <Btn variant="ghost" sm disabled={safeHistoryPage === 0} onClick={() => setHistoryPage(safeHistoryPage - 1)}>
                            <Icon name="chevLeft" size={13} /> Prev
                          </Btn>
                          <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                            Page {safeHistoryPage + 1} of {totalHistoryPages}
                          </span>
                          <Btn variant="ghost" sm disabled={safeHistoryPage >= totalHistoryPages - 1} onClick={() => setHistoryPage(safeHistoryPage + 1)}>
                            Next <Icon name="chevRight" size={13} />
                          </Btn>
                        </div>
                      )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          )}
          </Reveal>
        </main>


        {/* Right Column: "How it works" panel — persistent on desktop, always
            open, showing the current page's registered help. Hidden on mobile
            (the collapsible inside <main> serves narrow screens). Rendered only
            when the page registered help, or when local (for the dev tools). */}
        {(pageHelp || isLocal) && <aside className="hide-mobile" style={{
          width: 320, padding: 24, borderLeft: '1px solid var(--border)', background: 'var(--bg-alt)',
          display: 'flex', flexDirection: 'column', gap: 20, flexShrink: 0, overflowY: 'auto'
        }}>
          {pageHelp && (
            <>
              <div className="col" style={{ gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--burn-ink)', letterSpacing: '0.1em' }}>
                  This page
                </span>
                <h4 style={{ margin: 0, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>How it works</h4>
              </div>
              <div className="col" style={{ gap: 12, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
                {pageHelp}
              </div>
            </>
          )}

          {/* Local-dev tools — collapsed disclosure, never in prod. */}
          {isLocal && (
            <details style={{ marginTop: pageHelp ? 8 : 0, borderTop: pageHelp ? '1px solid var(--border)' : 'none', paddingTop: pageHelp ? 16 : 0 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--fg-3)', letterSpacing: '0.1em', listStyle: 'revert' }}>
                Dev tools (local only)
              </summary>
              <div className="col" style={{ gap: 18, marginTop: 14 }}>
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

                {/* Reset the mock proposals so you can vote again (local only) */}
                <div className="col" style={{ gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Mock proposals</span>
                  <Btn variant="secondary" sm onClick={async () => {
                    if (!actor) return;
                    const res = await actor.dev_reset_proposals();
                    if (res.__kind__ === "Err") { alert(`Failed: ${res.Err}`); return; }
                    await refreshAllData();
                  }}>
                    <Icon name="refresh" size={13} /> Reset proposals (vote again)
                  </Btn>
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    Wipes + reseeds the mock proposals and clears your votes/commitments on them.
                  </span>
                </div>

                {/* Page controls — local/dev controls the open page registered. */}
                {pageDevControls && (
                  <div className="col" style={{ gap: 8 }}>
                    {pageDevControls}
                  </div>
                )}

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
                      <span className="row" style={{ gap: 6, fontSize: 12.5, color: 'var(--sprout-ink)' }}>
                        <LiveDot color="var(--sprout-ink)" size={6} /> Active / Healthy
                      </span>
                    </div>
                  </div>
                </div>

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
                      <Icon name={hotkeyCopied ? "check" : "copy"} size={12} stroke={hotkeyCopied ? "var(--sprout-ink)" : "var(--burn-ink)"} /> Copy my principal
                    </Btn>
                  </div>
                )}
              </div>
            </details>
          )}
        </aside>}

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
                <Icon name="checkCircle" size={18} stroke="var(--sprout-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Follow the leader neuron</h4>
              </span>
              {!isVerifying && (
                <button onClick={() => setIsFollowModalOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
              Cycle Burn directs the community leader neuron based on
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
                  <Icon name={hotkeyCopied ? "check" : "copy"} size={12} stroke={hotkeyCopied ? "var(--sprout-ink)" : "var(--fg-3)"} />
                </button>
              </div>
              <a href="https://nns.ic0.app" target="_blank" rel="noreferrer" onClick={() => setNnsOpened(true)}
                style={{ fontSize: 12, color: 'var(--burn-ink)', textDecoration: 'none' }}>
                <Icon name={nnsOpened ? "check" : "external"} size={11} stroke={nnsOpened ? "var(--sprout-ink)" : "var(--burn-ink)"} /> Open the NNS dapp
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
                <Icon name="wallet" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Treasury Wallet</h4>
              </span>
              <button onClick={() => setIsTreasuryOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 12px', borderRadius: 6, background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))', border: '1px solid var(--burn)' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>Treasury balance</span>
              <span className="mono" style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)' }}>
                {treasuryBalance !== null ? `${fmtICP(treasuryBalance)} ICP` : "…"}
              </span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0, lineHeight: 1.5 }}>
              Accumulates the treasury share of every settled proposal's proceeds, and fronts the ledger fees that make commits and refunds fee-free for users. Without pool neurons: 50% treasury / 25% backend cycles / 25% frontend cycles. With active pool neurons: 25% each. Withdraw to any principal.
            </p>

            {treasurySuccess && (
              <div style={{ padding: 10, borderRadius: 6, background: 'var(--sprout-dim)', border: '1px solid var(--sprout)', color: 'var(--sprout-ink)', fontSize: 12.5 }}>Withdrawal sent.</div>
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
                <Icon name="wallet" size={18} stroke="var(--burn-ink)" />
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
                  {tokenBalances.ckbtc === null ? '…' : fmtTokenAmount(tokenBalances.ckbtc, 8)} ckBTC
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>ckETH</span>
                <span className="mono" style={{ fontSize: 14, color: 'var(--fg-1)' }}>
                  {tokenBalances.cketh === null ? '…' : fmtTokenAmount(tokenBalances.cketh, 18)} ckETH
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>ckUSDC</span>
                <span className="mono" style={{ fontSize: 14, color: 'var(--fg-1)' }}>
                  {tokenBalances.ckusdc === null ? '…' : fmtTokenAmount(tokenBalances.ckusdc, 6)} ckUSDC
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>ckUSDT</span>
                <span className="mono" style={{ fontSize: 14, color: 'var(--fg-1)' }}>
                  {tokenBalances.ckusdt === null ? '…' : fmtTokenAmount(tokenBalances.ckusdt, 6)} ckUSDT
                </span>
              </div>
            </div>

            {/* Deposit */}
            <div className="col" style={{ gap: 8 }}>
              <Eyebrow>Deposit · fund your app account</Eyebrow>
              <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0, lineHeight: 1.5 }}>
                This is <b>your</b> app account. Send ICP via the legacy account identifier (NNS dapp / exchanges), or send ICP, ckBTC, ckETH, ckUSDC, or ckUSDT from any ICRC-1 wallet straight to your principal.
              </p>
              <label style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>ICP account identifier (for NNS / exchanges)</label>
              <div className="row" style={{ gap: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', overflowWrap: 'anywhere', flex: 1 }}>{accountId || "…"}</span>
                <button onClick={() => { navigator.clipboard.writeText(accountId); setAddrCopied("aid"); setTimeout(() => setAddrCopied(""), 2000); }}
                  title="Copy account identifier" style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name={addrCopied === "aid" ? "check" : "copy"} size={12} stroke={addrCopied === "aid" ? "var(--sprout-ink)" : "var(--fg-3)"} />
                </button>
              </div>
              <label style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Principal (for ICP / ckBTC / ckETH / ckUSDC from ICRC-1 wallets)</label>
              <div className="row" style={{ gap: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg)', overflowWrap: 'anywhere', flex: 1 }}>{principal.toString()}</span>
                <button onClick={() => { navigator.clipboard.writeText(principal.toString()); setAddrCopied("principal"); setTimeout(() => setAddrCopied(""), 2000); }}
                  title="Copy principal" style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name={addrCopied === "principal" ? "check" : "copy"} size={12} stroke={addrCopied === "principal" ? "var(--sprout-ink)" : "var(--fg-3)"} />
                </button>
              </div>
            </div>

            <hr />

            {/* Withdraw */}
            <div className="col" style={{ gap: 8 }}>
              <Eyebrow>Withdraw · send tokens out</Eyebrow>
              <div className="row" style={{ gap: 6 }}>
                {WALLET_TOKENS.map(t => {
                  const meta = getWalletTokenMeta(t);
                  return (
                    <Btn key={t} variant={walletToken === t ? 'primary' : 'secondary'} sm
                      onClick={() => { setWalletToken(t); setWithdrawTo(""); setWithdrawAmount(""); setWithdrawError(null); setWithdrawSuccess(false); }}>
                      <span className="mono">{meta.label}</span>
                    </Btn>
                  );
                })}
              </div>
              {withdrawSuccess && (
                <div style={{ padding: 10, borderRadius: 6, background: 'var(--sprout-dim)', border: '1px solid var(--sprout)', color: 'var(--sprout-ink)', fontSize: 12.5 }}>
                  Withdrawal sent.
                </div>
              )}
              {withdrawError && (
                <div style={{ padding: 10, borderRadius: 6, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                  {withdrawError}
                </div>
              )}
              <input type="text"
                placeholder={walletToken === 'ICP' ? "Destination Account ID (64-char hex)" : "Destination principal"}
                className="burn-input" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
                value={withdrawTo} onChange={(e) => { setWithdrawTo(e.target.value); setWithdrawError(null); setWithdrawSuccess(false); }} />
              <div className="row" style={{ gap: 8 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input type="text" inputMode="decimal" placeholder="Amount" className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                    value={withdrawAmount} onChange={(e) => { setWithdrawAmount(e.target.value); setWithdrawError(null); setWithdrawSuccess(false); }} />
                  <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>
                    {getWalletTokenMeta(walletToken).label}
                  </span>
                </div>
                <Btn variant="secondary" sm
                  onClick={walletToken === 'ICP' ? handleWithdraw : handleWithdrawIcrc}
                  disabled={isWithdrawing || !withdrawTo || !withdrawAmount}>
                  {isWithdrawing ? <LiveDot size={7} color="var(--fg)" /> : <Icon name="arrowUp" size={13} />}
                  {isWithdrawing ? " Sending…" : " Withdraw"}
                </Btn>
              </div>
              <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.4, marginTop: 4 }}>
                <Icon name="info" size={11} stroke="var(--fg-3)" style={{ marginTop: 2, flexShrink: 0 }} />
                {walletToken === 'ICP'
                  ? 'ICP withdraws to a legacy Account ID (64-char hex). 0.0001 ICP network fee applies.'
                  : `${getWalletTokenMeta(walletToken).label} withdraws to a principal (ICRC-1). ${fmtTokenAmount(getWalletTokenMeta(walletToken).fee, getWalletTokenMeta(walletToken).decimals)} ${getWalletTokenMeta(walletToken).label} network fee applies.`}
              </span>
            </div>

            {walletVouchers.length > 0 && (
              <>
                <hr />
                <div className="col" style={{ gap: 8 }}>
                  <Eyebrow>Bonds · your staked positions as NFTs</Eyebrow>
                  {voucherXferMsg && (
                    <div style={{ padding: 10, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)', color: 'var(--fg-2)', fontSize: 12 }}>
                      {voucherXferMsg}
                    </div>
                  )}
                  {walletVouchers.map((v) => {
                    const promo = isPromo(v.class);
                    const listed = v.listed_price_e8s != null;
                    return (
                      <div key={String(v.id)} className="col" style={{ gap: 8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-alt)' }}>
                        <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                          <span className="row" style={{ gap: 8 }}>
                            <Icon name={promo ? 'spark' : 'star'} size={13} stroke={promo ? 'var(--haze-ink)' : 'var(--burn-ink)'} />
                            <b style={{ fontSize: 12.5 }}>{promo ? 'Golden Ticket' : `${fmtICP(v.amount_e8s)} ICP · ${TIER_META[v.tier].short}`}</b>
                            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>#{String(v.id)}</span>
                          </span>
                          {promo ? <Chip tone="muted" style={{ height: 17, fontSize: 9.5 }}>non-transferable</Chip>
                            : listed ? <Chip tone="burn" style={{ height: 17, fontSize: 9.5 }}>listed</Chip>
                            : voucherXferId === v.id ? null
                            : (
                              <Btn variant="secondary" sm onClick={() => { setVoucherXferId(v.id); setVoucherXferTo(""); setVoucherXferMsg(null); }}>
                                <Icon name="arrowUp" size={11} /> Withdraw
                              </Btn>
                            )}
                        </div>
                        {!promo && !listed && voucherXferId === v.id && (
                          <div className="col" style={{ gap: 6 }}>
                            <span style={{ fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.4 }}>
                              Send this bond to another wallet's principal (Plug / OISY / NNS). This moves the
                              <b> stake and its ticket stream there permanently</b> — double-check the principal.
                            </span>
                            <input type="text" placeholder="Destination principal" className="burn-input" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                              value={voucherXferTo} onChange={(e) => { setVoucherXferTo(e.target.value); setVoucherXferMsg(null); }} />
                            <div className="row" style={{ gap: 6 }}>
                              <Btn variant="secondary" sm onClick={() => handleVoucherTransfer(v.id)} disabled={voucherXferBusy || !voucherXferTo}>
                                {voucherXferBusy ? <LiveDot size={7} /> : <Icon name="arrowUp" size={12} />} Confirm send
                              </Btn>
                              <Btn variant="ghost" sm onClick={() => { setVoucherXferId(null); setVoucherXferTo(""); }}>Cancel</Btn>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.4, marginTop: 2 }}>
                    <Icon name="info" size={11} stroke="var(--fg-3)" style={{ marginTop: 2, flexShrink: 0 }} />
                    <span>
                      <b>Deposit a bond held elsewhere?</b> Sign in as that wallet and withdraw it here targeting your
                      principal: <span className="mono" style={{ overflowWrap: 'anywhere' }}>{principal.toString()}</span>
                    </span>
                  </span>
                </div>
              </>
            )}
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
                <Icon name="info" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>About the Neuron Pool</h4>
              </span>
              <button onClick={() => setPoolDetailsOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>What is the Neuron Syndicate?</Eyebrow>
              <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                Neuron Syndicate members point their NNS neuron at the community leader (verified on-chain via a hotkey). Each neuron automatically votes the way the leader votes, and their combined voting power gives the community more influence over NNS proposals.
              </p>
            </div>

            <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>Status badges</Eyebrow>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Chip tone="ok" style={{ height: 20, fontSize: 10, flexShrink: 0 }}><Icon name="check" size={10} /> Active - Paid</Chip>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  Ranked in the <strong style={{ color: 'var(--fg)' }}>top 100</strong> by voting power — earns a share of every settled proposal's payout.
                </span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Chip tone="muted" style={{ height: 20, fontSize: 10, flexShrink: 0 }}>Active</Chip>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  Following the leader, but outside the top 100 — not currently receiving payouts. Grow your voting power to move up the ranks.
                </span>
              </div>
            </div>

            <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>Voting power (VP)</Eyebrow>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                Each neuron contributes its NNS voting power. Neurons are ranked by VP — the higher your VP, the higher your rank, and the top 100 are the paid tier (ties for the last slot go to the higher VP). The total VP is the sum across all active neurons.
              </p>
            </div>

            <div className="col" style={{ gap: 6, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <Eyebrow>How to join</Eyebrow>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                Follow the community leader and add this app's canister as a hotkey, then pay the one-time initiation fee{config ? ` (${fmtICP(config.pool_initiation_fee_e8s)} ICP)` : ''} to activate. Once active, your neuron votes with the community and is eligible for payouts if it reaches the top 100.
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
              <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Stop following?</h4>
            </div>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
              Your neuron <span className="mono" style={{ color: 'var(--fg)' }}>#{confirmLeaveId.toString()}</span> will become <strong style={{ color: 'var(--fg)' }}>Inactive</strong> and stop earning payouts. You can reactivate it later — the initiation fee is not refunded.
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
                <Icon name="spark" size={18} stroke="var(--burn-ink)" />
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
                    background: poolWizardStep >= s ? 'var(--burn)' : 'var(--border)',
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
                  <Eyebrow>What is the Neuron Syndicate?</Eyebrow>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.55 }}>
                    Point your neuron's voting power at the community leader (verified via a hotkey). Your neuron automatically votes the same way the leader does, and the top 100 by voting power earn a share of each settled burn.
                  </p>
                </div>
                <div className="col" style={{ gap: 8, padding: 12, borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <Eyebrow>Initiation fee</Eyebrow>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>One-time fee</span>
                    <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>
                      {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP
                    </span>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                    Charged once when you confirm at the final step — there's no per-vote cost after that.
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
                <Eyebrow accent>Step 2 of 3 — Verify your neuron</Eyebrow>

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
                  <a href={NNS_HOTKEY_DOCS} target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: 'var(--burn-ink)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="external" size={11} stroke="var(--burn-ink)" /> How NNS neuron hotkeys work
                  </a>
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
                    style={{ fontSize: 12, color: 'var(--burn-ink)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="external" size={11} stroke="var(--burn-ink)" /> Open NNS dapp
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
                      <Icon name="checkCircle" size={24} stroke="var(--sprout-ink)" />
                    </div>
                    <div className="col" style={{ gap: 4 }}>
                      <h5 style={{ margin: 0, color: 'var(--fg)' }}>You're in the Neuron Syndicate!</h5>
                      <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
                        Your neuron now follows the community leader and votes with it. Payouts land in your app wallet after each settled proposal (top 100 by voting power).
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
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>One-time fee (from app wallet)</span>
                          <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--burn-ink)' }}>
                            {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP
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
                      {config && holdings < config.pool_initiation_fee_e8s ? (
                        <Btn variant="primary" style={{ flex: 1 }}
                          onClick={() => { setIsPoolWizardOpen(false); setPage('payouts'); setWalletRequest(n => n + 1); }}>
                          <Icon name="wallet" size={14} stroke="var(--char-950)" /> Add ICP to wallet
                        </Btn>
                      ) : (
                        <Btn variant="primary" style={{ flex: 1 }}
                          onClick={handlePoolPayAndFinalize}
                          disabled={isPoolFinalizing || isCancellingDraft}>
                          {isPoolFinalizing ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="coins" size={14} stroke="var(--char-950)" />}
                          {isPoolFinalizing ? ' Processing…' : ' Pay & Activate'}
                        </Btn>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'center' }}>
                      Closing this dialog keeps your Draft saved — resume anytime from the Neuron Syndicate page.
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
                <Icon name="flame" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>
                  Confirm Conviction Burn
                </h4>
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
                  color: 'var(--sprout-ink)'
                }}>
                  <Icon name="checkCircle" size={24} stroke="var(--sprout-ink)" />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <h5 style={{ margin: 0, color: 'var(--fg)' }}>Commitment Registered!</h5>
                  <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
                    Your {confirmAmount} {voteToken} is locked in escrow. If the proposal reaches threshold and the neuron votes, it's spent — <b>50% treasury / 25% backend cycles / 25% frontend cycles</b> (with active pool neurons: 25% treasury / 25% backend / 25% frontend / 25% pool). If threshold isn't met, it's returned to your wallet.
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
                        ? <><Icon name="checkCircle" size={11} stroke="var(--sprout-ink)" /> ADOPT</>
                        : <><Icon name="x" size={11} /> REJECT</>}
                    </Chip>
                  </div>
                </div>

                {/* Amount — entered in USD; priced into ICP (votes are ICP-only). */}
                <div className="col" style={{ gap: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
                    How much ICP to burn? (USD)
                  </label>
                  {/* USD presets */}
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {[1, 2, 5, 10, 20, 100].map(usd => (
                      <Btn key={usd} variant={confirmUsd === String(usd) ? 'primary' : 'ghost'} sm
                        onClick={() => { setConfirmUsd(String(usd)); setTxError(null); }}>
                        ${usd}
                      </Btn>
                    ))}
                  </div>
                  <div style={{ position: 'relative' }}>
                    <span className="mono" style={{
                      position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                      fontSize: 22, color: 'var(--fg-3)', pointerEvents: 'none'
                    }}>$</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="0"
                      className="burn-input"
                      style={{ fontSize: 22, padding: '10px 14px 10px 30px', fontFamily: 'var(--font-mono)' }}
                      value={confirmUsd}
                      onChange={(e) => { setConfirmUsd(e.target.value); setTxError(null); }}
                      autoFocus
                    />
                  </div>
                  {/* Priced into the selected token */}
                  {confirmAmount && (
                    <span className="row" style={{ gap: 8, fontSize: 11.5, color: 'var(--fg-3)' }}>
                      <Icon name="info" size={11} stroke="var(--fg-3)" />
                      ≈ {confirmAmount} {voteToken}{voteToken !== 'ICP' ? <> · stays escrowed as {voteToken}; converts to ICP only if the vote passes — refunded in {voteToken} if it doesn't</> : null}
                    </span>
                  )}
                  {/* Min only — no wallet balance shown here */}
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                      Min: <span className="mono" style={{ color: 'var(--fg-2)' }}>${MIN_COMMIT_USD}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsHelpOpen(true)}
                      style={{
                        background: 'none', border: 'none', color: 'var(--burn-ink)',
                        fontSize: 11.5, cursor: 'pointer', padding: 0,
                        display: 'flex', alignItems: 'center', gap: 4, textDecoration: 'underline'
                      }}
                    >
                      <Icon name="info" size={11} stroke="var(--burn-ink)" /> What is this?
                    </button>
                  </div>
                </div>

                {/* Zero-fee commits: what you commit is what counts — no fee table */}
                <div className="col" style={{ gap: 8, fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
                    <span style={{ color: 'var(--fg)' }}>Committed weight</span>
                    <span className="mono" style={{ color: confirmAmount ? 'var(--burn-ink)' : 'var(--fg-3)' }}>
                      {confirmAmount ? parseFloat(confirmAmount).toFixed(4) : "—"} {voteToken}
                    </span>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                    No fees — if the vote misses its threshold you get back exactly what you committed.
                  </span>
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
                  ⚠️ <b>Commitment is final.</b> Your funds move into escrow for this proposal. If it reaches threshold and the neuron votes, your commitment is spent; if not, it is returned in full.
                </div>

                {isTransacting ? (
                  <div className="col" style={{ alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <LiveDot size={8} color="var(--burn-ink)" />
                    <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{txStep}</span>
                  </div>
                ) : (() => {
                  // Balance of the SELECTED currency vs the priced token amount.
                  const meta = WALLET_TOKEN_META[voteToken];
                  const needed = parseTokenUnits(confirmAmount || '0', meta.decimals) ?? 0n;
                  // Raw balance keeps `null` (still loading) distinct from 0 so the
                  // gate doesn't falsely read "Not enough funds" before non-ICP
                  // balances have been fetched. ICP (`holdings`) is always loaded.
                  const balRaw: bigint | null = voteToken === 'ICP' ? holdings
                    : voteToken === 'ckBTC' ? tokenBalances.ckbtc
                    : voteToken === 'ckETH' ? tokenBalances.cketh
                    : voteToken === 'ckUSDC' ? tokenBalances.ckusdc
                    : tokenBalances.ckusdt;
                  const usd = parseFloat(confirmUsd);
                  const hasAmount = isFinite(usd) && usd > 0 && needed > 0n;
                  const belowMin = hasAmount && usd < MIN_COMMIT_USD;
                  const insufficient = hasAmount && commitInsufficient(balRaw, needed);
                  const canSubmit = tier >= 2 && hasAmount && !belowMin && !insufficient && treasuryCanFront;
                  return (
                  <div className="col" style={{ gap: 8 }}>
                    {!treasuryCanFront && tier >= 2 && (
                      <span style={{ fontSize: 11.5, color: 'var(--haze-ink)' }}>
                        Voting is paused — the treasury can't currently cover the ledger fees a commitment needs at settlement. Try again shortly.
                      </span>
                    )}
                    <div className="row" style={{ gap: 12 }}>
                      <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setIsConfirming(false)}>
                        Cancel
                      </Btn>
                      <Btn
                        variant="primary"
                        style={{ flex: 1 }}
                        disabled={!canSubmit}
                        onClick={() => { if (canSubmit) executeTransaction(); }}
                      >
                        <Icon name="flame" size={14} stroke="var(--char-950)" /> {!treasuryCanFront ? 'Voting paused' : insufficient ? 'Not enough funds' : belowMin ? `Minimum is $${MIN_COMMIT_USD}` : 'Submit'}
                      </Btn>
                    </div>
                  </div>
                  );
                })()}
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
                <Icon name="flame" size={18} stroke="var(--burn-ink)" />
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
                  color: 'var(--sprout-ink)'
                }}>
                  <Icon name="checkCircle" size={24} stroke="var(--sprout-ink)" />
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
                      min="0"
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
                    <span>Min: <span className="mono" style={{ color: 'var(--fg-2)' }}>${MIN_COMMIT_USD} in ICP</span></span>
                    <span>Wallet: <span className="mono" style={{ color: 'var(--fg-2)' }}>{fmtICP(holdings)} ICP</span></span>
                  </div>
                </div>

                {/* Zero-fee top-up summary */}
                <div className="col" style={{ gap: 8, fontSize: 13, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
                    <span style={{ color: 'var(--fg)' }}>Additional weight</span>
                    <span className="mono" style={{ color: addMoreAmount ? 'var(--burn-ink)' : 'var(--fg-3)' }}>
                      {addMoreAmount ? parseFloat(addMoreAmount).toFixed(4) : "—"} ICP
                    </span>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                    No fees — refunds return exactly what you committed.
                  </span>
                </div>

                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
                  ⚠️ <b>Top-up is final.</b> Your additional ICP joins the same escrow. Your stance ({existingCommitment?.stance === Stance.Adopt ? 'ADOPT' : 'REJECT'}) cannot be changed.
                </div>

                {isAddMoreTransacting ? (
                  <div className="col" style={{ alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <LiveDot size={8} color="var(--burn-ink)" />
                    <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{addMoreTxStep}</span>
                  </div>
                ) : (() => {
                  // Same $1-worth minimum as the Open-proposal commit (shared helper).
                  const addMoreValid = meetsMinCommitIcp(parseFloat(addMoreAmount), usdRates[ExplorerToken.ICP] ?? 0n);
                  return (
                  <div className="row" style={{ gap: 12 }}>
                    <Btn variant="secondary" style={{ flex: 1 }} onClick={() => setIsAddingMore(false)}>
                      Cancel
                    </Btn>
                    <Btn
                      variant="primary"
                      style={{ flex: 1, opacity: addMoreValid ? 1 : 0.45 }}
                      disabled={!addMoreValid}
                      onClick={executeAddMore}
                    >
                      <Icon name="flame" size={14} stroke="var(--char-950)" /> Add {addMoreAmount ? `${parseFloat(addMoreAmount).toFixed(1)} ICP` : "ICP"}
                    </Btn>
                  </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* ── Staged transaction modals (take over after the confirm dialogs) ── */}
      {commitTx.isOpen && <TxModal flow={commitTx} onClose={commitTx.reset} />}
      {addMoreTx.isOpen && <TxModal flow={addMoreTx} onClose={addMoreTx.reset} />}

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
                <Icon name="info" size={18} stroke="var(--burn-ink)" />
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
                      <li>If the threshold isn't met, your commitment is returned to your wallet in full — exactly what you put in.</li>
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
                <Icon name="info" size={18} stroke="var(--burn-ink)" />
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
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Min Burn ($1 in ICP)</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  The minimum commit is $1 worth of ICP, valued live via the XRC oracle, to commit to any governance proposal. This ensures voting signals represent meaningful economic conviction and prevents spam.
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
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>Fees</span>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  None. Cycle Burn charges no protocol fee and the treasury covers every ledger fee on your behalf. If the proposal fails to meet its threshold, the committed amount is returned to you in full — exactly what you put in.
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
        {/* Drawer Header — the Cycle Burn brand up top, close on the right */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, width: '100%' }}>
          <span className="row" style={{ gap: 9, alignItems: 'center' }}>
            <BrandMark size={24} style={{ flexShrink: 0 }} />
            <b style={{ fontSize: 16, color: 'var(--fg)', whiteSpace: 'nowrap' }}>Cycle Burn</b>
          </span>
          <button
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--fg-2)', padding: 4, display: 'flex', alignItems: 'center'
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {renderDrawerBody(() => setMobileMenuOpen(false))}
      </div>
    </div>
    </PageHelpContext.Provider>
    </DevControlsContext.Provider>
  );
}

// Simple type definitions helper
function Eyrow({ children }: { children: React.ReactNode }) {
  return <Eyebrow style={{ marginTop: 2 }}>{children}</Eyebrow>;
}
