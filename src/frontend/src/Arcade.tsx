import { useEffect, useState } from 'react';
import { useHashScreen } from './nav';
import { Principal } from "@icp-sdk/core/principal";
import { ExplorerToken } from "./bindings/backend";
import type { ArcadeInfo, ArcadeLeaderboardRow, ExplorerInfo, ExplorerQuote } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, formatPrincipal } from "./ui";
import { fmtTokenAmount } from "./IdeaBoard";
import { useErrorImpression } from "./analytics";
import FieldGoal from "./arcade/FieldGoal";
import CourseMarketplace from "./CourseMarketplace";
import CourseCreate from "./CourseCreate";
import CoursePlay from "./CoursePlay";
import { courseIdFromScreen, spectateIdFromScreen } from "./arcade/courseMarket";
import MiniGolf from "./arcade/MiniGolf";
import type { CourseCard } from "./bindings/backend";
import {
  ROUNDS_PER_GAME as FG_ROUNDS, MIN_DISTANCE_YDS, MAX_DISTANCE_YDS,
  DEFAULT_KICKER, HELMET_COLORS, JERSEY_COLORS, type KickerLook,
} from "./arcade/fieldgoalEngine";
import {
  fmtMillis,
  HAIR_COLORS, HAIR_NAMES, SKIN_COLORS, SKIN_NAMES, OUTFIT_COLORS, OUTFIT_NAMES,
  DEFAULT_CHARACTER, type CharacterLook,
  COURSE as CALDERA_COURSE, COURSE_PAR_TOTAL as CALDERA_PAR,
} from "./arcade/engine";

// Caldera Ridge — the original built-in 9-hole course that shipped with Mini
// Golf before course NFTs (PB-301+). It's not an NFT (no token_id), so it plays
// for fun straight through the MiniGolf engine, with no marketplace/sale badge.
const CALDERA_COURSE_NAME = 'Caldera Ridge';

// ==========================================
// Arcade — participation-gated skill games.
// Two games (Mini Golf, Field Goal), each with its own sub-page, leaderboard,
// $1 persona AND feature flag (the parent `arcade` flag is the master switch;
// per-game flags pull one title at a time).
// ==========================================

// Mini-golf scores are retired (PB-309); only Field Goal still writes to the
// shared arcade leaderboard.
const GAME_FIELDGOAL = 'fieldgoal';

// The outfit palette doubles as helmet/jersey colors — team-ish names.
const HELMET_NAMES = OUTFIT_NAMES;
const JERSEY_NAMES = OUTFIT_NAMES;

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
  backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 16,
};

interface ArcadeProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  backendCanisterId: string;
  isLocal: boolean;
  onSignIn: () => void;
  onGoParticipate: () => void;
  /** 'arcade' = full hub (Mini Golf + Field Goal tabs). 'minigolf' = dedicated
   *  Mini Golf page: hash base `/mini-golf`, tab locked to mini golf, Field
   *  Goal tab/card hidden. Defaults to 'arcade'. */
  mode?: 'arcade' | 'minigolf';
}

function shadeHex(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + delta));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + delta));
  const b = Math.max(0, Math.min(255, (n & 255) + delta));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** SVG twin of the in-game voxel mini-figure (matches MiniGolf's drawGolfer). */
function GolferPreview({ look, size = 96 }: { look: CharacterLook; size?: number }) {
  const skin = SKIN_COLORS[look.skin] ?? SKIN_COLORS[0];
  const hair = HAIR_COLORS[look.hair] ?? HAIR_COLORS[0];
  const outfit = OUTFIT_COLORS[look.outfit] ?? OUTFIT_COLORS[0];
  const pants = shadeHex(outfit, -60);
  const outfitDark = shadeHex(outfit, -28);
  const skinDark = shadeHex(skin, -26);
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="Your golfer" shapeRendering="crispEdges">
      <ellipse cx="24" cy="44.5" rx="11" ry="3.4" fill="rgba(0,0,0,0.32)" />
      {/* legs (voxel columns) + shoes */}
      <rect x="18" y="30" width="5" height="13" fill={pants} />
      <rect x="25" y="30" width="5" height="13" fill={pants} />
      <rect x="17" y="41" width="6.5" height="3" fill="#26211c" />
      <rect x="24.5" y="41" width="6.5" height="3" fill="#26211c" />
      {/* torso block + darker side sliver */}
      <rect x="16" y="13" width="14" height="18" fill={outfit} />
      <rect x="30" y="13" width="3" height="18" fill={outfitDark} />
      {/* arms + putter */}
      <line x1="18" y1="18" x2="33" y2="27" stroke={skin} strokeWidth="3" />
      <line x1="29" y1="18" x2="33" y2="27" stroke={skin} strokeWidth="3" />
      <line x1="33" y1="27" x2="38" y2="43" stroke="#9b9b9b" strokeWidth="2" />
      <rect x="36" y="42" width="6" height="3.4" fill="#6f6f6f" />
      {/* head block + side shading + hair slab */}
      <rect x="18" y="1" width="12" height="12" fill={skin} />
      <rect x="28" y="1" width="2" height="12" fill={skinDark} />
      <rect x="17" y="-1" width="14" height="5" fill={hair} />
      <rect x="17" y="2" width="3" height="6" fill={hair} />
    </svg>
  );
}

/** SVG twin of the in-game kicker mini-figure (matches FieldGoal's drawKicker). */
function KickerPreview({ look, size = 96 }: { look: KickerLook; size?: number }) {
  const skin = SKIN_COLORS[look.skin] ?? SKIN_COLORS[0];
  const helmet = HELMET_COLORS[look.helmet] ?? HELMET_COLORS[0];
  const jersey = JERSEY_COLORS[look.jersey] ?? JERSEY_COLORS[0];
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="Your kicker" shapeRendering="crispEdges">
      <ellipse cx="24" cy="44.5" rx="11" ry="3.4" fill="rgba(0,0,0,0.32)" />
      {/* legs (kicking foot forward) + cleats */}
      <rect x="17" y="30" width="5" height="13" fill="#d8d8d8" />
      <rect x="25" y="29" width="5" height="12" fill="#d8d8d8" />
      <rect x="16" y="41" width="6.5" height="3" fill="#26211c" />
      <rect x="25" y="39" width="7.5" height="3" fill="#26211c" />
      {/* jersey torso + sleeve stripe */}
      <rect x="14" y="14" width="19" height="17" fill={jersey} />
      <rect x="14" y="16" width="19" height="2" fill="rgba(255,255,255,0.55)" />
      {/* arms */}
      <line x1="16" y1="18" x2="9" y2="28" stroke={skin} strokeWidth="3" />
      <line x1="31" y1="18" x2="38" y2="27" stroke={skin} strokeWidth="3" />
      {/* head + helmet + facemask */}
      <rect x="18" y="4" width="12" height="11" fill={skin} />
      <rect x="16" y="1" width="16" height="9" fill={helmet} />
      <rect x="16" y="8" width="4" height="5" fill={helmet} />
      <line x1="24" y1="12" x2="32" y2="12" stroke="#cfcfcf" strokeWidth="2" />
      {/* football at his feet */}
      <ellipse cx="38" cy="42" rx="5" ry="3.2" fill="#8a4a22" />
      <line x1="36" y1="42" x2="40" y2="42" stroke="#f5efe0" strokeWidth="1" />
    </svg>
  );
}

// Supported payment tokens for the $1 customization fee. fallbackFee MUST
// match the per-token ledger fee (a flat fallback under-funded ckETH
// deposits by the whole transfer fee — review 2026-06-11).
const PAY_TOKENS: { token: ExplorerToken; label: string; decimals: number; fallbackFee: bigint }[] = [
  { token: ExplorerToken.ICP, label: 'ICP', decimals: 8, fallbackFee: 10_000n },
  { token: ExplorerToken.CkBTC, label: 'ckBTC', decimals: 8, fallbackFee: 10n },
  { token: ExplorerToken.CkETH, label: 'ckETH', decimals: 18, fallbackFee: 2_000_000_000_000n },
  { token: ExplorerToken.CkUSDC, label: 'ckUSDC', decimals: 6, fallbackFee: 10_000n },
  { token: ExplorerToken.CkUSDT, label: 'ckUSDT', decimals: 6, fallbackFee: 10_000n },
];

function payTokenLedger(token: ExplorerToken, exp: ExplorerInfo | null): string | null {
  if (!exp) return null;
  switch (token) {
    case ExplorerToken.ICP: return exp.icp_ledger.toString();
    case ExplorerToken.CkBTC: return exp.ckbtc_ledger.toString();
    case ExplorerToken.CkETH: return exp.cketh_ledger.toString();
    case ExplorerToken.CkUSDC: return exp.ckusdc_ledger.toString();
    case ExplorerToken.CkUSDT: return exp.ckusdt_ledger.toString();
  }
}

function payTokenFee(token: ExplorerToken, exp: ExplorerInfo | null): bigint {
  if (!exp) return PAY_TOKENS.find(t => t.token === token)!.fallbackFee;
  switch (token) {
    case ExplorerToken.ICP: return exp.fee_icp_e8s;
    case ExplorerToken.CkBTC: return exp.fee_ckbtc_sats;
    case ExplorerToken.CkETH: return exp.fee_cketh_wei;
    case ExplorerToken.CkUSDC: return exp.fee_ckusdc_micro;
    case ExplorerToken.CkUSDT: return exp.fee_ckusdt_micro;
  }
}

export default function Arcade({ actor, identity, principal, host, rootKey, ledgerCanisterId, backendCanisterId, isLocal, onSignIn, onGoParticipate, mode = 'arcade' }: ArcadeProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const minigolfMode = mode === 'minigolf';

  const [info, setInfo] = useState<ArcadeInfo | null>(null);
  const [expInfo, setExpInfo] = useState<ExplorerInfo | null>(null);
  const [boardFG, setBoardFG] = useState<ArcadeLeaderboardRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Mini Golf is now the Course Marketplace (PB-309): the tab shows the
  // marketplace; "play" opens a course in the engine. Courses are AI-built —
  // there is no in-app editor. The active view lives in the hash (#/arcade,
  // #/arcade/course/<id>, …) so Back returns to the lobby, not off the page —
  // and `course/<id>` doubles as each course's shareable deep link. The
  // dedicated Mini Golf page reuses this component with base `/mini-golf`.
  const [view, setView] = useHashScreen<'lobby' | 'fieldgoal' | 'classic-play' | 'create-course' | `course/${string}` | `spectate/${string}`>(minigolfMode ? '/mini-golf' : '/arcade', 'lobby');
  const [playCard, setPlayCard] = useState<CourseCard | null>(null);
  // `skipOverview` is set by the marketplace "Play" click so CoursePlay drops
  // straight into the scored round, bypassing the 3×3 overview. A fresh
  // deep-link load (reload at `#/mini-golf/course/<id>`) leaves it false, so the
  // overview still shows for shared-link visitors. Cleared on exit.
  const [skipOverview, setSkipOverview] = useState(false);
  // Deep-link resolution: when the hash names a course we don't have a card
  // for (a shared link, the "View NFT" grid, or a reload), fetch it. The hash
  // can be `course/<id>` (play) or `spectate/<id>` (view-only 3×3 grid).
  // `deepLinkErr` = course gone.
  const deepLinkCourseId = courseIdFromScreen(view);
  const spectateCourseId = spectateIdFromScreen(view);
  const routeCourseId = deepLinkCourseId ?? spectateCourseId;
  const [deepLinkErr, setDeepLinkErr] = useState(false);
  useEffect(() => {
    setDeepLinkErr(false);
    if (routeCourseId === null || !actor) return;
    if (playCard && playCard.token_id === routeCourseId) return;
    let cancelled = false;
    (async () => {
      try {
        const card = await actor.get_course(routeCourseId);
        if (cancelled) return;
        if (card) setPlayCard(card); else setDeepLinkErr(true);
      } catch {
        if (!cancelled) setDeepLinkErr(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, actor]);
  // Lobby sub-page — one per game (its card, persona and leaderboard).
  const [tab, setTab] = useState<'minigolf' | 'fieldgoal'>('minigolf');
  const [submitNote, setSubmitNote] = useState<string | undefined>(undefined);

  // Persona editor — one modal, two targets (golfer / kicker).
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<'golfer' | 'kicker'>('golfer');
  const [draft, setDraft] = useState<CharacterLook>(DEFAULT_CHARACTER);
  // Golfer/kicker customize is ICP-only — no multi-token selector.
  const payToken = ExplorerToken.ICP;
  const payMeta = PAY_TOKENS[0];
  const [payQuote, setPayQuote] = useState<ExplorerQuote | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorStep, setEditorStep] = useState('');
  useErrorImpression(editorError, 'course_editor');
  const [editorBusy, setEditorBusy] = useState(false);

  // Live $1 quote in the chosen token while the editor is open.
  useEffect(() => {
    if (!isEditorOpen || !signedIn || !actor) { setPayQuote(null); return; }
    let cancelled = false;
    setIsQuoting(true);
    setPayQuote(null);
    actor.get_arcade_customize_quote(payToken)
      .then((res: any) => {
        if (cancelled) return;
        if (res.__kind__ === "Ok") { setPayQuote(res.Ok); setEditorError(null); }
        else setEditorError(`Quote failed: ${res.Err}`);
      })
      .catch((err: any) => { if (!cancelled) setEditorError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setIsQuoting(false); });
    return () => { cancelled = true; };
  }, [isEditorOpen, payToken, signedIn, actor]);

  const refreshAll = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      // Mini-golf leaderboard + built-in course are retired (PB-309); only the
      // Field Goal board + arcade/explorer info are fetched here now.
      const [arcadeInfo, rowsFG, explorerInfo] = await Promise.all([
        currentActor.get_arcade_info(),
        currentActor.get_arcade_leaderboard(GAME_FIELDGOAL),
        currentActor.get_explorer_info(),
      ]);
      setInfo(arcadeInfo);
      setExpInfo(explorerInfo);
      setBoardFG(rowsFG);
    } catch (err) {
      console.error("Failed to fetch Arcade:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    refreshAll(actor);
  }, [actor, signedIn]);

  const myLook: CharacterLook = info?.my_character
    ? { hair: info.my_character.hair, skin: info.my_character.skin, outfit: info.my_character.outfit }
    : DEFAULT_CHARACTER;
  // The kicker reuses ArcadeCharacter with hair→helmet, outfit→jersey.
  const myKicker: KickerLook = info?.my_kicker
    ? { helmet: info.my_kicker.hair, skin: info.my_kicker.skin, jersey: info.my_kicker.outfit }
    : DEFAULT_KICKER;
  const fullAccess = info?.full_access ?? false;
  const myRowFG = signedIn ? boardFG.find(r => r.player.toString() === principal!.toString()) : undefined;

  // Per-game kill switches: hide a disabled game's tab entirely; if the
  // active tab's game got pulled, fall back to the first enabled one.
  const golfOn = info?.minigolf_enabled ?? true;
  const fgOn = info?.fieldgoal_enabled ?? true;
  const enabledTabs = ([
    golfOn ? 'minigolf' : null,
    fgOn ? 'fieldgoal' : null,
  ].filter(Boolean)) as ('minigolf' | 'fieldgoal')[];
  // The dedicated Mini Golf page only ever shows mini golf — lock the tab.
  const activeTab = minigolfMode
    ? 'minigolf'
    : (enabledTabs.includes(tab) ? tab : (enabledTabs[0] ?? 'minigolf'));

  const submitScore = async (game: string, perHole: number[], millis: number, noun: string) => {
    if (!signedIn || !actor) {
      setSubmitNote(`Sign in to put your ${noun} on the leaderboard.`);
      return;
    }
    if (!fullAccess) return; // gate screen already blocked the full game
    try {
      setSubmitNote(`Submitting your ${noun}…`);
      const res = await actor.submit_arcade_score(game, BigInt(millis), Uint8Array.from(perHole));
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setSubmitNote(`On the board — rank #${res.Ok} (best ${noun} counts).`);
      refreshAll();
    } catch (err: any) {
      console.error("Score submit failed:", err);
      setSubmitNote(`Score submit failed: ${err.message || err}`);
    }
  };
  const handleKicksComplete = (perKick: number[], millis: number) =>
    submitScore(GAME_FIELDGOAL, perKick, millis, 'game');

  // Draft reuses CharacterLook fields for every target (hair→helmet,
  // skin→skin, outfit→jersey).
  const draftOf = (target: 'golfer' | 'kicker'): CharacterLook =>
    target === 'golfer' ? myLook
      : { hair: myKicker.helmet, skin: myKicker.skin, outfit: myKicker.jersey };

  const openEditor = (target: 'golfer' | 'kicker') => {
    if (!signedIn) { onSignIn(); return; }
    setEditorTarget(target);
    setDraft(draftOf(target));
    setEditorError(null);
    setEditorStep('');
    setIsEditorOpen(true);
  };

  const executeCustomize = async () => {
    if (!actor || !identity || !info || editorBusy) return;
    const current = draftOf(editorTarget);
    if (draft.hair === current.hair && draft.skin === current.skin && draft.outfit === current.outfit) {
      setEditorError("That's already your current look.");
      return;
    }
    if (!payQuote) {
      setEditorError("Waiting for the price quote — try again in a second.");
      return;
    }
    const meta = payMeta;
    const ledger = payTokenLedger(payToken, expInfo);
    if (!ledger) { setEditorError("Token ledger unavailable."); return; }
    const fee = payTokenFee(payToken, expInfo);
    setEditorBusy(true);
    setEditorError(null);
    try {
      setEditorStep(`Step 1/2: Paying $1 in ${meta.label}...`);
      const acct = await actor.get_arcade_deposit_address();
      const ledgerActor = createLedgerActor(ledger, {
        agentOptions: { host, identity, rootKey }
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: acct.owner,
          subaccount: acct.subaccount ? acct.subaccount : undefined,
        },
        amount: payQuote.amount + fee,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const detail = err.__kind__ === "InsufficientFunds"
          ? `balance is ${fmtTokenAmount(err.InsufficientFunds.balance, meta.decimals)} ${meta.label} — the look costs ${fmtTokenAmount(payQuote.amount, meta.decimals)} ${meta.label} + fees`
          : JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Payment failed: ${detail}`);
      }
      setEditorStep("Step 2/2: Saving your look on-chain...");
      const res = editorTarget === 'golfer'
        ? await actor.customize_character(draft.hair, draft.skin, draft.outfit, payToken)
        : await actor.customize_kicker(draft.hair, draft.skin, draft.outfit, payToken);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setIsEditorOpen(false);
      await refreshAll();
    } catch (err: any) {
      console.error("Customize error:", err);
      setEditorError(err.message || String(err));
    } finally {
      setEditorBusy(false);
    }
  };

  // Course play — reached from the marketplace Play button OR directly via a
  // shared `#/arcade/course/<id>` link (the card is fetched by the effect above).
  // `spectate/<id>` is the View-NFT 3×3 grid: same CoursePlay, spectate-only.
  if (routeCourseId !== null) {
    if (playCard && playCard.token_id === routeCourseId) {
      return (
        <div className="idea-board-container">
          <CoursePlay
            actor={actor}
            card={playCard}
            character={myLook}
            spectateOnly={spectateCourseId !== null}
            autoStartRound={skipOverview}
            onExit={() => { setPlayCard(null); setSkipOverview(false); setTab('minigolf'); setView('lobby'); }}
            onGoParticipate={onGoParticipate}
          />
        </div>
      );
    }
    return (
      <div className="idea-board-container">
        {deepLinkErr ? (
          <div className="col" style={{ alignItems: 'center', gap: 14, padding: '48px 0', color: 'var(--fg-3)' }}>
            <Icon name="x" size={26} stroke="var(--ember)" />
            <span style={{ fontSize: 14, color: 'var(--ember)' }}>This course doesn't exist (or was burned).</span>
            <Btn variant="secondary" onClick={() => { setTab('minigolf'); setView('lobby'); }}>Browse the marketplace</Btn>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 48, color: 'var(--fg-3)' }}>
            <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
            Loading course #{routeCourseId.toString()}…
          </div>
        )}
      </div>
    );
  }

  // Create a course — copy the AI-designer instructions, upload the JSON it
  // returns, test-play, then mint. Exiting returns to the lobby, which
  // remounts CourseMarketplace (it refreshes itself on mount).
  if (view === 'create-course') {
    return (
      <div className="idea-board-container">
        <CourseCreate
          actor={actor}
          identity={identity}
          host={host}
          rootKey={rootKey}
          ledgerCanisterId={ledgerCanisterId}
          character={myLook}
          onExit={() => { setTab('minigolf'); setView('lobby'); }}
          onMinted={() => { setTab('minigolf'); setView('lobby'); }}
        />
      </div>
    );
  }

  // Caldera Ridge — the original built-in course. No token_id / scored session;
  // it runs straight in the MiniGolf engine and is played for fun (the old
  // built-in leaderboard stayed retired with PB-309).
  if (view === 'classic-play') {
    return (
      <div className="idea-board-container">
        <MiniGolf
          course={CALDERA_COURSE}
          character={myLook}
          fullAccess={fullAccess}
          onRoundComplete={() => { /* play-for-fun: classic course isn't scored */ }}
          onExit={() => { setTab('minigolf'); setView('lobby'); }}
          onGoParticipate={onGoParticipate}
        />
      </div>
    );
  }

  if (view === 'fieldgoal' && !minigolfMode) {
    return (
      <div className="idea-board-container">
        <FieldGoal
          kicker={myKicker}
          fullAccess={fullAccess}
          onRoundComplete={handleKicksComplete}
          onExit={() => { setTab('fieldgoal'); setView('lobby'); setSubmitNote(undefined); refreshAll(); }}
          onGoParticipate={onGoParticipate}
          submitNote={submitNote}
        />
      </div>
    );
  }

  return (
    <div className="idea-board-container">
      {/* ── Page header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Play &amp; compete</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name={minigolfMode ? 'golf' : 'gamepad'} size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>{minigolfMode ? 'Mini Golf' : 'Arcade'}</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560 }}>
            Skill games for protocol participants. Everyone gets a free preview — stake ICP
            or vote on a proposal (within the last 30 days) to unlock full games and the
            leaderboards.
          </p>
        </div>
        {signedIn && !fullAccess && (
          <Chip tone="pending"><Icon name="lock" size={11} /> Free preview only — stake or vote to unlock</Chip>
        )}
      </div>

      {/* ── Game sub-pages (per-game flags hide pulled titles) ── */}
      {!minigolfMode && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {golfOn && (
            <Btn variant={activeTab === 'minigolf' ? 'primary' : 'ghost'} sm onClick={() => setTab('minigolf')}>
              <Icon name="golf" size={13} stroke={activeTab === 'minigolf' ? 'var(--char-950)' : 'currentColor'} />
              Mini Golf
            </Btn>
          )}
          {fgOn && (
            <Btn variant={activeTab === 'fieldgoal' ? 'primary' : 'ghost'} sm onClick={() => setTab('fieldgoal')}>
              <Icon name="zap" size={13} stroke={activeTab === 'fieldgoal' ? 'var(--char-950)' : 'currentColor'} />
              Field Goal
            </Btn>
          )}
        </div>
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
          Loading arcade...
        </div>
      ) : activeTab === 'minigolf' ? (
        <>
          {/* Mini Golf is now the Course Marketplace (PB-309). A row of two
              cards sits above it: the original built-in "Caldera Ridge" course
              (left) and the golfer persona (right). Marketplace courses below earn
              tickets; Caldera Ridge plays for fun (no sale badge — it's not an NFT). */}
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {/* Caldera Ridge — original course, left of the golfer card */}
            <div className="card col" style={{ gap: 8, flex: '1 1 260px' }}>
              <span style={LABEL_STYLE}>Classic course</span>
              <h6 style={{ margin: 0, fontSize: 16 }}>{CALDERA_COURSE_NAME}</h6>
              <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>9 holes</Chip>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Par {CALDERA_PAR}</Chip>
              </span>
              <p style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1 }}>
                The original nine — the course that shipped before the course
                marketplace. Play it free, just for the round.
              </p>
              <Btn variant="primary" sm style={{ alignSelf: 'flex-start' }} onClick={() => setView('classic-play')}>
                <Icon name="flame" size={11} stroke="var(--char-950)" /> Play
              </Btn>
            </div>

            {/* Your golfer persona */}
            <div className="card row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap', flex: '1 1 320px' }}>
              <GolferPreview look={myLook} size={72} />
              <div className="col" style={{ gap: 4 }}>
                <span style={LABEL_STYLE}>Your golfer</span>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{HAIR_NAMES[myLook.hair]}</Chip>
                  <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{SKIN_NAMES[myLook.skin]}</Chip>
                  <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{OUTFIT_NAMES[myLook.outfit]}</Chip>
                </span>
              </div>
              <Btn variant="secondary" sm style={{ marginLeft: 'auto' }} onClick={() => openEditor('golfer')}>
                <Icon name="edit" size={12} /> Customize · $1 in any token
              </Btn>
            </div>
          </div>

          <CourseMarketplace
            actor={actor}
            principal={principal}
            identity={identity}
            host={host}
            rootKey={rootKey}
            ledgerCanisterId={ledgerCanisterId}
            backendCanisterId={backendCanisterId}
            isLocal={isLocal}
            onPlay={(card) => { setPlayCard(card); setSkipOverview(true); setView(`course/${card.token_id}`); }}
            onViewNft={(card) => { setPlayCard(card); setView(`spectate/${card.token_id}`); }}
            onCreate={() => setView('create-course')}
            onSignIn={onSignIn}
          />
        </>
      ) : (
        <>
          {/* ── Field Goal: game + kicker cards ── */}
          <div className="idea-grid">
            <div className="card col" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <Chip tone="burn" style={{ height: 19, fontSize: 10 }}>
                  <LiveDot color="var(--burn-ink)" size={5} /> Game 2
                </Chip>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                  {FG_ROUNDS} kicks · {MIN_DISTANCE_YDS}–{MAX_DISTANCE_YDS} yds
                </span>
              </div>
              <h6 style={{ margin: 0, fontSize: 16 }}>Field Goal</h6>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1 }}>
                Five kicks, each from a random distance and hash. From the snap you get
                <b> 3 seconds</b> to aim and let it fly — hesitate and the rushed kick sails
                wide or dies short. A make scores its distance in yards; most points wins.
              </p>
              {myRowFG && (
                <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                  <Icon name="target" size={11} /> Your best: {myRowFG.strokes} pts · {fmtMillis(Number(myRowFG.millis))} · rank #{myRowFG.rank}
                </Chip>
              )}
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                  {fullAccess ? 'Full game unlocked' : 'Kick 1 free preview'}
                </span>
                <Btn variant="primary" sm onClick={() => {
                  if (!signedIn) { onSignIn(); return; }
                  setSubmitNote(undefined);
                  setView('fieldgoal');
                }}>
                  <Icon name="zap" size={11} stroke="var(--char-950)" /> {signedIn ? 'Play' : 'Sign in to play'}
                </Btn>
              </div>
            </div>

            {/* Kicker persona card */}
            <div className="card col" style={{ gap: 10, alignItems: 'center' }}>
              <span style={LABEL_STYLE}>Your kicker</span>
              <KickerPreview look={myKicker} size={104} />
              <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{HELMET_NAMES[myKicker.helmet]} helmet</Chip>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{SKIN_NAMES[myKicker.skin]}</Chip>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{JERSEY_NAMES[myKicker.jersey]} jersey</Chip>
              </span>
              <Btn variant="secondary" sm onClick={() => openEditor('kicker')}>
                <Icon name="edit" size={12} /> Customize · $1 in any token
              </Btn>
            </div>
          </div>

          <LeaderboardSection
            title="Field Goal — leaderboard"
            sub="· best game per player · top 100"
            scoreHeader="Points"
            rows={boardFG}
            empty="No games on the board yet. Drill the first kick."
            principal={signedIn ? principal : null}
          />
        </>
      )}

      {/* ── Character editor modal ── */}
      {isEditorOpen && info && (
        <div style={MODAL_OVERLAY} onClick={() => !editorBusy && setIsEditorOpen(false)}>
          <div className="card col" style={{
            maxWidth: 460, width: '100%', gap: 14, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '90vh', overflowY: 'auto',
          }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="edit" size={15} stroke="var(--burn-ink)" />
                <b>Customize your {editorTarget}</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !editorBusy && setIsEditorOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>
            <div className="row" style={{ justifyContent: 'center' }}>
              {editorTarget === 'golfer'
                ? <GolferPreview look={draft} size={120} />
                : <KickerPreview look={{ helmet: draft.hair, skin: draft.skin, jersey: draft.outfit }} size={120} />}
            </div>
            {(editorTarget === 'golfer' ? [
              ['Hair', HAIR_COLORS, HAIR_NAMES, draft.hair, (i: number) => setDraft(d => ({ ...d, hair: i }))],
              ['Skin', SKIN_COLORS, SKIN_NAMES, draft.skin, (i: number) => setDraft(d => ({ ...d, skin: i }))],
              ['Outfit', OUTFIT_COLORS, OUTFIT_NAMES, draft.outfit, (i: number) => setDraft(d => ({ ...d, outfit: i }))],
            ] as const : [
              ['Helmet', HELMET_COLORS, HELMET_NAMES, draft.hair, (i: number) => setDraft(d => ({ ...d, hair: i }))],
              ['Skin', SKIN_COLORS, SKIN_NAMES, draft.skin, (i: number) => setDraft(d => ({ ...d, skin: i }))],
              ['Jersey', JERSEY_COLORS, JERSEY_NAMES, draft.outfit, (i: number) => setDraft(d => ({ ...d, outfit: i }))],
            ] as const).map(([label, colors, names, sel, set]) => (
              <div key={label} className="col" style={{ gap: 6 }}>
                <label style={LABEL_STYLE}>{label} · {names[sel]}</label>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {colors.map((c, i) => (
                    <button key={c} onClick={() => { set(i); setEditorError(null); }} title={names[i]} style={{
                      width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer',
                      border: i === sel ? '2px solid var(--burn)' : '2px solid var(--border)',
                      boxShadow: i === sel ? '0 0 0 2px color-mix(in srgb, var(--burn) 35%, transparent)' : 'none',
                    }} />
                  ))}
                </span>
              </div>
            ))}
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Pay with · $1 in ICP at the live rate</label>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                {isQuoting ? 'Fetching live ICP price…'
                  : payQuote ? `= ${fmtTokenAmount(payQuote.amount, payMeta.decimals)} ${payMeta.label} · paid to the protocol treasury · rate locked 15 min`
                  : 'Fetching live ICP price…'}
              </span>
            </div>
            {editorStep && !editorError && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{editorStep}</span>}
            {editorError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{editorError}</span>}
            <Btn variant="primary" disabled={editorBusy || !payQuote} onClick={executeCustomize}>
              {editorBusy ? 'Working...'
                : payQuote ? `Pay ${fmtTokenAmount(payQuote.amount, payMeta.decimals)} ${payMeta.label} ($1) & save look`
                : 'Pay $1 & save look'}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

const LB_TH: React.CSSProperties = { padding: '6px 10px', textAlign: 'center', fontWeight: 500 };
const LB_TD: React.CSSProperties = { padding: '7px 10px', textAlign: 'center' };

function LeaderboardSection({ title, sub, scoreHeader, rows, empty, principal }: {
  title: string;
  sub: string;
  scoreHeader: string;
  rows: ArcadeLeaderboardRow[];
  empty: string;
  principal: Principal | null;
}) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <span className="row" style={{ gap: 8 }}>
        <Icon name="target" size={14} stroke="var(--burn-ink)" />
        <b style={{ fontSize: 14, color: 'var(--fg)' }}>{title}</b>
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{sub}</span>
      </span>
      {rows.length === 0 ? (
        <div className="col" style={{ alignItems: 'center', gap: 10, padding: '32px 0', color: 'var(--fg-3)' }}>
          <Icon name="target" size={26} stroke="var(--fg-dim)" />
          <span style={{ fontSize: 13 }}>{empty}</span>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
            <thead>
              <tr className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={LB_TH}>#</th>
                <th style={{ ...LB_TH, textAlign: 'left' }}>Player</th>
                <th style={LB_TH}>{scoreHeader}</th>
                <th style={LB_TH}>Time</th>
                <th style={LB_TH}>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const mine = principal !== null && r.player.toString() === principal.toString();
                return (
                  <tr key={r.rank} style={{
                    borderTop: '1px solid var(--border)',
                    background: mine ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                  }}>
                    <td style={{ ...LB_TD, color: r.rank <= 3 ? 'var(--burn-ink)' : 'var(--fg-3)', fontWeight: r.rank <= 3 ? 700 : 400 }}>{r.rank}</td>
                    <td style={{ ...LB_TD, textAlign: 'left' }} className="mono">
                      {formatPrincipal(r.player)}{mine ? ' · you' : ''}
                    </td>
                    <td style={LB_TD} className="mono">{r.strokes.toString()}</td>
                    <td style={LB_TD} className="mono">{fmtMillis(Number(r.millis))}</td>
                    <td style={{ ...LB_TD, color: 'var(--fg-3)' }} className="mono">
                      {new Date(Number(r.submitted_at / 1_000_000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
