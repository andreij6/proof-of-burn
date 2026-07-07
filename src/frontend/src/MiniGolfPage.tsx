import { useEffect, useState } from 'react';
import { useHashScreen } from './nav';
import { Principal } from "@icp-sdk/core/principal";
import { ExplorerToken } from "./bindings/backend";
import type { ArcadeInfo, ExplorerInfo, ExplorerQuote } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot } from "./ui";
import { fmtTokenAmount } from "./tokens";
import { useErrorImpression } from "./analytics";
import CourseMarketplace from "./CourseMarketplace";
import CourseCreate from "./CourseCreate";
import CoursePlay from "./CoursePlay";
import { courseIdFromScreen, spectateIdFromScreen, playIdFromScreen } from "./arcade/courseMarket";
import MiniGolf from "./arcade/MiniGolf";
import type { CourseCard } from "./bindings/backend";
import {
  HAIR_COLORS, HAIR_NAMES, SKIN_COLORS, SKIN_NAMES, OUTFIT_COLORS, OUTFIT_NAMES,
  DEFAULT_CHARACTER, type CharacterLook,
  COURSE as CALDERA_COURSE, COURSE_PAR_TOTAL as CALDERA_PAR,
} from "./arcade/engine";

// Caldera Ridge — the original built-in 9-hole course that shipped with Mini
// Golf before course NFTs (PB-301+). It's not an NFT (no token_id), so it plays
// for fun straight through the MiniGolf engine, with no marketplace/sale badge.
const CALDERA_COURSE_NAME = 'Caldera Ridge';

// ==========================================
// Mini Golf — the dedicated page (formerly the Arcade hub's mini-golf tab;
// the hub and Field Goal were removed 2026-07). Hosts the course
// marketplace, AI course creation, course play/spectate deep links, the
// classic Caldera Ridge course, and the golfer persona editor.
// ==========================================

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
  backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 16,
};

interface MiniGolfPageProps {
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

export default function MiniGolfPage({ actor, identity, principal, host, rootKey, ledgerCanisterId, backendCanisterId, isLocal, onSignIn, onGoParticipate }: MiniGolfPageProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [info, setInfo] = useState<ArcadeInfo | null>(null);
  const [expInfo, setExpInfo] = useState<ExplorerInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The lobby shows the Course Marketplace (PB-309); "play" opens a course in
  // the engine. Courses are AI-built — there is no in-app editor. The active
  // view lives in the hash (#/mini-golf, #/mini-golf/course/<id>, …) so Back
  // returns to the lobby, not off the page — and `course/<id>` doubles as each
  // course's shareable deep link (`#/arcade/course/<id>` links from before the
  // hub removal resolve here too — see App.pageFromHash).
  const [view, setView] = useHashScreen<'lobby' | 'classic-play' | 'create-course' | `course/${string}` | `spectate/${string}` | `play/${string}`>('/mini-golf', 'lobby');
  const [playCard, setPlayCard] = useState<CourseCard | null>(null);
  // Deep-link resolution: when the hash names a course we don't have a card
  // for (a shared link, the "View NFT" grid, or a reload), fetch it. The hash
  // can be `course/<id>` (the overview / shareable deep link), `spectate/<id>`
  // (the View-NFT view-only 3×3 grid), or `play/<id>` (the marketplace "Play"
  // button — drops straight into the scored round). `deepLinkErr` = course gone.
  const deepLinkCourseId = courseIdFromScreen(view);
  const spectateCourseId = spectateIdFromScreen(view);
  const playCourseId = playIdFromScreen(view);
  const routeCourseId = deepLinkCourseId ?? spectateCourseId ?? playCourseId;
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

  // Persona editor (golfer).
  const [isEditorOpen, setIsEditorOpen] = useState(false);
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
      const [arcadeInfo, explorerInfo] = await Promise.all([
        currentActor.get_arcade_info(),
        currentActor.get_explorer_info(),
      ]);
      setInfo(arcadeInfo);
      setExpInfo(explorerInfo);
    } catch (err) {
      console.error("Failed to fetch Mini Golf:", err);
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
  const fullAccess = info?.full_access ?? false;

  const openEditor = () => {
    if (!signedIn) { onSignIn(); return; }
    setDraft(myLook);
    setEditorError(null);
    setEditorStep('');
    setIsEditorOpen(true);
  };

  const executeCustomize = async () => {
    if (!actor || !identity || !info || editorBusy) return;
    const current = myLook;
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
      setEditorStep('Step 1/2: Paying 0.5 ICP...');
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
      const res = await actor.customize_character(draft.hair, draft.skin, draft.outfit, payToken);
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
            autoStartRound={playCourseId !== null}
            onExit={() => { setPlayCard(null); setView('lobby'); }}
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
            <Btn variant="secondary" onClick={() => setView('lobby')}>Browse the marketplace</Btn>
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
          onExit={() => setView('lobby')}
          onMinted={() => setView('lobby')}
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
          onExit={() => setView('lobby')}
          onGoParticipate={onGoParticipate}
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
            <Icon name="golf" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Mini Golf</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560 }}>
            Skill games — sign in and play everything, free. Staked players also earn
            lottery tickets while they play.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
          Loading Mini Golf...
        </div>
      ) : (
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
              <Btn variant="secondary" sm style={{ marginLeft: 'auto' }} onClick={() => openEditor()}>
                <Icon name="edit" size={12} /> Customize · 0.5 ICP
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
            onPlay={(card) => { setPlayCard(card); setView(`play/${card.token_id}`); }}
            onViewNft={(card) => { setPlayCard(card); setView(`spectate/${card.token_id}`); }}
            onCreate={() => setView('create-course')}
            onGoStaking={onGoParticipate}
            onSignIn={onSignIn}
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
                <b>Customize your golfer</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !editorBusy && setIsEditorOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>
            <div className="row" style={{ justifyContent: 'center' }}>
              <GolferPreview look={draft} size={120} />
            </div>
            {([
              ['Hair', HAIR_COLORS, HAIR_NAMES, draft.hair, (i: number) => setDraft(d => ({ ...d, hair: i }))],
              ['Skin', SKIN_COLORS, SKIN_NAMES, draft.skin, (i: number) => setDraft(d => ({ ...d, skin: i }))],
              ['Outfit', OUTFIT_COLORS, OUTFIT_NAMES, draft.outfit, (i: number) => setDraft(d => ({ ...d, outfit: i }))],
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
              <label style={LABEL_STYLE}>Price · flat 0.5 ICP</label>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                {isQuoting ? 'Preparing your quote…'
                  : payQuote ? `${fmtTokenAmount(payQuote.amount, payMeta.decimals)} ${payMeta.label} · 50% treasury / 25% backend / 25% NFT canister`
                  : 'Preparing your quote…'}
              </span>
            </div>
            {editorStep && !editorError && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{editorStep}</span>}
            {editorError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{editorError}</span>}
            <Btn variant="primary" disabled={editorBusy || !payQuote} onClick={executeCustomize}>
              {editorBusy ? 'Working...'
                : payQuote ? `Pay ${fmtTokenAmount(payQuote.amount, payMeta.decimals)} ${payMeta.label} & save look`
                : 'Pay 0.5 ICP & save look'}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
