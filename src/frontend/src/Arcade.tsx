import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { ExplorerToken } from "./bindings/backend";
import type { ArcadeInfo, ArcadeLeaderboardRow, ExplorerInfo, ExplorerQuote } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, formatPrincipal } from "./ui";
import { fmtTokenAmount } from "./IdeaBoard";
import MiniGolf from "./arcade/MiniGolf";
import {
  COURSE, HOLES_PER_ROUND, fmtMillis, mergeCourse,
  HAIR_COLORS, HAIR_NAMES, SKIN_COLORS, SKIN_NAMES, OUTFIT_COLORS, OUTFIT_NAMES,
  DEFAULT_CHARACTER, type CharacterLook, type HoleDef,
} from "./arcade/engine";

// ==========================================
// Arcade — participation-gated skill games.
// One game today (Mini Golf Gold); the lobby + per-game leaderboard are
// keyed by game id so future titles (and a combined board) slot in.
// ==========================================

const GAME_MINIGOLF = 'minigolf';

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

export default function Arcade({ actor, identity, principal, host, rootKey, onSignIn, onGoParticipate }: ArcadeProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [info, setInfo] = useState<ArcadeInfo | null>(null);
  const [expInfo, setExpInfo] = useState<ExplorerInfo | null>(null);
  const [board, setBoard] = useState<ArcadeLeaderboardRow[]>([]);
  const [course, setCourse] = useState<HoleDef[]>(COURSE);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<'lobby' | 'game'>('lobby');
  const [submitNote, setSubmitNote] = useState<string | undefined>(undefined);

  // Character editor
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [draft, setDraft] = useState<CharacterLook>(DEFAULT_CHARACTER);
  const [payToken, setPayToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [payQuote, setPayQuote] = useState<ExplorerQuote | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorStep, setEditorStep] = useState('');
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
      const [arcadeInfo, rows, overrides, explorerInfo] = await Promise.all([
        currentActor.get_arcade_info(),
        currentActor.get_arcade_leaderboard(GAME_MINIGOLF),
        currentActor.get_arcade_course(),
        currentActor.get_explorer_info(),
      ]);
      setInfo(arcadeInfo);
      setExpInfo(explorerInfo);
      setBoard(rows);
      // Admin-edited hole layouts (on-chain) override the built-in course.
      setCourse(mergeCourse(overrides));
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
  const fullAccess = info?.full_access ?? false;
  const myRow = signedIn ? board.find(r => r.player.toString() === principal!.toString()) : undefined;

  const handleRoundComplete = async (perHole: number[], millis: number) => {
    if (!signedIn || !actor) {
      setSubmitNote("Sign in to put your round on the leaderboard.");
      return;
    }
    if (!fullAccess) return; // gate screen already blocked holes 2–9
    try {
      setSubmitNote("Submitting your round…");
      const res = await actor.submit_arcade_score(GAME_MINIGOLF, BigInt(millis), Uint8Array.from(perHole));
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setSubmitNote(`On the board — rank #${res.Ok} (best round counts).`);
      refreshAll();
    } catch (err: any) {
      console.error("Score submit failed:", err);
      setSubmitNote(`Score submit failed: ${err.message || err}`);
    }
  };

  const openEditor = () => {
    if (!signedIn) { onSignIn(); return; }
    setDraft(myLook);
    setEditorError(null);
    setEditorStep('');
    setIsEditorOpen(true);
  };

  const executeCustomize = async () => {
    if (!actor || !identity || !info || editorBusy) return;
    if (draft.hair === myLook.hair && draft.skin === myLook.skin && draft.outfit === myLook.outfit) {
      setEditorError("That's already your current look.");
      return;
    }
    if (!payQuote) {
      setEditorError("Waiting for the price quote — try again in a second.");
      return;
    }
    const meta = PAY_TOKENS.find(t => t.token === payToken)!;
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

  if (view === 'game') {
    return (
      <div className="idea-board-container">
        <MiniGolf
          course={course}
          character={myLook}
          fullAccess={fullAccess}
          onRoundComplete={handleRoundComplete}
          onExit={() => { setView('lobby'); setSubmitNote(undefined); refreshAll(); }}
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
            <Icon name="gamepad" size={22} stroke="var(--burn)" />
            <h4 style={{ margin: 0 }}>Arcade</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560 }}>
            Skill games for protocol participants. Everyone can preview hole 1 — stake ICP
            or vote on a proposal (within the last 30 days) to unlock full rounds and the
            leaderboard. Fewest strokes wins; ties go to the fastest time.
          </p>
        </div>
        {signedIn && !fullAccess && (
          <Chip tone="pending"><Icon name="lock" size={11} /> Hole 1 preview only — stake or vote to unlock</Chip>
        )}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
          Loading arcade...
        </div>
      ) : (
        <>
          {/* ── Game + character cards ── */}
          <div className="idea-grid">
            {/* Mini Golf Gold */}
            <div className="card col" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <Chip tone="burn" style={{ height: 19, fontSize: 10 }}>
                  <LiveDot color="var(--burn)" size={5} /> Game 1
                </Chip>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{HOLES_PER_ROUND} holes · Par {course.reduce((s, h) => s + h.par, 0)}</span>
              </div>
              <h6 style={{ margin: 0, fontSize: 16 }}>Mini Golf Gold</h6>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1 }}>
                Classic table-top mini golf: drag back from the ball, release to putt. Banks,
                bunkers, water, slopes and a windmill stand between you and the cup. One
                player, nine holes, every stroke and second counts.
              </p>
              {myRow && (
                <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                  <Icon name="target" size={11} /> Your best: {myRow.strokes} strokes · {fmtMillis(Number(myRow.millis))} · rank #{myRow.rank}
                </Chip>
              )}
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                  {fullAccess ? 'Full round unlocked' : 'Hole 1 free preview'}
                </span>
                <Btn variant="primary" sm onClick={() => {
                  if (!signedIn) { onSignIn(); return; }
                  setSubmitNote(undefined);
                  setView('game');
                }}>
                  <Icon name="flame" size={11} stroke="var(--char-950)" /> {signedIn ? 'Play' : 'Sign in to play'}
                </Btn>
              </div>
            </div>

            {/* Character card */}
            <div className="card col" style={{ gap: 10, alignItems: 'center' }}>
              <span style={LABEL_STYLE}>Your golfer</span>
              <GolferPreview look={myLook} size={104} />
              <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{HAIR_NAMES[myLook.hair]}</Chip>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{SKIN_NAMES[myLook.skin]}</Chip>
                <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{OUTFIT_NAMES[myLook.outfit]}</Chip>
              </span>
              <Btn variant="secondary" sm onClick={openEditor}>
                <Icon name="edit" size={12} /> Customize · $1 in any token
              </Btn>
            </div>
          </div>

          {/* ── Leaderboard ── */}
          <div className="col" style={{ gap: 10 }}>
            <span className="row" style={{ gap: 8 }}>
              <Icon name="target" size={14} stroke="var(--burn)" />
              <b style={{ fontSize: 14, color: 'var(--fg)' }}>Mini Golf Gold — leaderboard</b>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· best round per player · top 100</span>
            </span>
            {board.length === 0 ? (
              <div className="col" style={{ alignItems: 'center', gap: 10, padding: '32px 0', color: 'var(--fg-3)' }}>
                <Icon name="target" size={26} stroke="var(--fg-dim)" />
                <span style={{ fontSize: 13 }}>No rounds on the board yet. Set the first time.</span>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                  <thead>
                    <tr className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      <th style={LB_TH}>#</th>
                      <th style={{ ...LB_TH, textAlign: 'left' }}>Player</th>
                      <th style={LB_TH}>Strokes</th>
                      <th style={LB_TH}>Time</th>
                      <th style={LB_TH}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.map(r => {
                      const mine = signedIn && r.player.toString() === principal!.toString();
                      return (
                        <tr key={r.rank} style={{
                          borderTop: '1px solid var(--border)',
                          background: mine ? 'var(--burn-950)' : 'transparent',
                        }}>
                          <td style={{ ...LB_TD, color: r.rank <= 3 ? 'var(--burn)' : 'var(--fg-3)', fontWeight: r.rank <= 3 ? 700 : 400 }}>{r.rank}</td>
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
                <Icon name="edit" size={15} stroke="var(--burn)" />
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
                      boxShadow: i === sel ? '0 0 0 2px var(--burn-950)' : 'none',
                    }} />
                  ))}
                </span>
              </div>
            ))}
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Pay with · $1 at the live rate</label>
              <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {PAY_TOKENS.map(t => (
                  <button key={t.label} onClick={() => { setPayToken(t.token); setEditorError(null); }}
                    style={{
                      background: payToken === t.token ? 'var(--burn-950)' : 'transparent',
                      border: `1px solid ${payToken === t.token ? 'var(--burn)' : 'var(--border)'}`,
                      color: payToken === t.token ? 'var(--burn)' : 'var(--fg-3)',
                      borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 500,
                      cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
                    }}>
                    {t.label}
                  </button>
                ))}
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                {isQuoting ? 'Fetching live price…'
                  : payQuote ? `= ${fmtTokenAmount(payQuote.amount, PAY_TOKENS.find(t => t.token === payToken)!.decimals)} ${PAY_TOKENS.find(t => t.token === payToken)!.label} · paid to the protocol treasury · rate locked 15 min`
                  : 'Pick a token to get a price.'}
              </span>
            </div>
            {editorStep && !editorError && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{editorStep}</span>}
            {editorError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{editorError}</span>}
            <Btn variant="primary" disabled={editorBusy || !payQuote} onClick={executeCustomize}>
              {editorBusy ? 'Working...'
                : payQuote ? `Pay ${fmtTokenAmount(payQuote.amount, PAY_TOKENS.find(t => t.token === payToken)!.decimals)} ${PAY_TOKENS.find(t => t.token === payToken)!.label} ($1) & save look`
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
