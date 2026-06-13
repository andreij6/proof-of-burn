import { useEffect, useRef, useState, useCallback } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import type {
  CrashRoundView, CrashBetView, CrashHistoryItem, CrashVerifyView,
  MyCasinoView, ChatMsgView, CrashStrategy, AutopilotState,
} from './bindings/backend';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal } from './ui';
import {
  multiplierX100, fmtX, historyChipTone, betButton, recomputeCrashX100,
  effectiveTargetX100, type BetPhase,
} from './crashMath';
import Poker from './Poker';

interface CasinoProps {
  actor: any;
  principal: Principal | null;
  isLocal: boolean;
  onSignIn: () => void;
  /** Jump to the Staking tab — chips come from staking. */
  onGoStaking: () => void;
  crashEnabled?: boolean;
  pokerEnabled?: boolean;
}

// The C16 doctrine — repeated on the hub header, the game header, the bet panel
// footer, and every bust screen. Enforced as copy, not memory.
export const NO_LOSS_DOCTRINE =
  'No loss of principal — ever. Chips are voting power earned by staking. Your staked ICP is never wagered, never at risk, and always unstakeable in full.';

function opt<T>(o: any): T | null {
  if (!o) return null;
  if (o.__kind__ === 'Some') return o.value as T;
  if (Array.isArray(o)) return o.length ? (o[0] as T) : null;
  return null;
}

const VP_E8S = 100_000_000;

function vpFromE8s(e8s: bigint | number): string {
  return (Number(e8s) / VP_E8S).toFixed(2);
}

export default function Casino({ actor, principal, isLocal, onSignIn, onGoStaking, crashEnabled = true, pokerEnabled = false }: CasinoProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  // Casino is a hub: a landing page of game cards, each opening a dedicated
  // screen. The active screen lives in the hash (/casino, /casino/crash,
  // /casino/poker) so deep links and the browser back button work.
  const screenFromHash = (): 'hub' | 'crash' | 'poker' => {
    const h = typeof window !== 'undefined' ? window.location.hash : '';
    if (h.includes('/casino/crash')) return 'crash';
    if (h.includes('/casino/poker')) return 'poker';
    return 'hub';
  };
  const [screen, setScreenState] = useState<'hub' | 'crash' | 'poker'>(screenFromHash());
  const goScreen = (s: 'hub' | 'crash' | 'poker') => {
    setScreenState(s);
    if (typeof window !== 'undefined') {
      window.location.hash = s === 'hub' ? '#/casino' : `#/casino/${s}`;
    }
  };
  // React to hash changes (back/forward, or the Casino nav button resetting to
  // the hub from a game screen).
  useEffect(() => {
    const onHash = () => setScreenState(screenFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [pokerLobby, setPokerLobby] = useState<{ tables: number; players: number; live: number } | null>(null);
  const [round, setRound] = useState<CrashRoundView | null>(null);
  const [history, setHistory] = useState<CrashHistoryItem[]>([]);
  const [me, setMe] = useState<MyCasinoView | null>(null);
  const [chat, setChat] = useState<ChatMsgView[]>([]);
  const [strategies, setStrategies] = useState<CrashStrategy[]>([]);
  const [autopilot, setAutopilot] = useState<AutopilotState | null>(null);
  const [wager, setWager] = useState('5');
  const [targetX, setTargetX] = useState('2.00');
  const [autoCash, setAutoCash] = useState(true);
  const [chatText, setChatText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0); // drives the live curve at ~10fps
  const [verify, setVerify] = useState<{ item: CrashHistoryItem; data?: CrashVerifyView; client?: number } | null>(null);
  const [muted, setMuted] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const [chatTab, setChatTab] = useState<'chat' | 'history'>('chat');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  const phase = (round?.phase ?? 'intermission') as BetPhase;

  const refresh = useCallback(async () => {
    if (!actor) return;
    try {
      // Nudge the round loop forward (no-op on a healthy subnet; drives it
      // locally where idle timers don't fire). Fire-and-forget.
      actor.crash_poke?.().catch(() => {});
      const [r, h] = await Promise.all([
        actor.get_crash_round(),
        actor.get_crash_history(20n),
      ]);
      setRound(r);
      setHistory(h);
      const sinceId = chat.length ? chat[chat.length - 1].id : 0n;
      const newChat = await actor.get_casino_chat(sinceId);
      if (newChat.length) setChat((c) => [...c, ...newChat].slice(-200));
      if (signedIn) {
        const [mc, ap, st] = await Promise.all([
          actor.get_my_casino(),
          actor.get_my_autopilot(),
          actor.list_crash_strategies(),
        ]);
        setMe(mc);
        setAutopilot(opt<AutopilotState>(ap));
        setStrategies(st);
      }
    } catch { /* flag raced off / transient — next poll recovers */ }
  }, [actor, signedIn, chat]);

  // Poll the crash game only while its screen is open (1 s during a round).
  useEffect(() => {
    if (screen !== 'crash') return;
    refresh();
    const ms = phase === 'running' || phase === 'betting' ? 1000 : 3000;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [refresh, phase, screen]);

  // Light hub poll: a stat preview for each game card.
  useEffect(() => {
    if (screen !== 'hub' || !actor) return;
    let stop = false;
    const tickHub = async () => {
      try {
        if (pokerEnabled) {
          const rows = await actor.get_poker_lobby();
          if (!stop) {
            const players = rows.reduce((a: number, r: any) => a + Number(r.seats_taken), 0);
            const live = rows.filter((r: any) => r.phase !== 'idle' && r.phase !== 'waiting').length;
            setPokerLobby({ tables: rows.length, players, live });
          }
        }
      } catch { /* transient */ }
    };
    tickHub();
    const t = setInterval(tickHub, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [screen, actor, crashEnabled, pokerEnabled]);

  // Local animation clock for the live curve / countdown.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  // ── SFX (arcade-style WebAudio; honours a local mute) ──
  const beep = useCallback((freq: number, dur: number, type: OscillatorType = 'sine') => {
    if (muted) return;
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      const ac = audioRef.current;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.06, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + dur);
    } catch { /* no audio device */ }
  }, [muted]);

  const prevPhase = useRef<BetPhase>('intermission');
  useEffect(() => {
    if (prevPhase.current !== 'crashed' && phase === 'crashed') beep(110, 0.5, 'sawtooth'); // explosion
    if (prevPhase.current === 'intermission' && phase === 'betting') beep(660, 0.08, 'square'); // bet lock-in
    prevPhase.current = phase;
  }, [phase, beep]);

  // Live multiplier during the run, from run_started_at (clients all agree).
  const liveX100 = (() => {
    if (phase !== 'running' || !round) return 100;
    const startMs = Number(BigInt(round.run_started_at) / 1_000_000n);
    return multiplierX100(Date.now() - startMs);
  })();

  // ── Canvas curve ──
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0c0d0f';
    ctx.fillRect(0, 0, W, H);
    const crashed = phase === 'crashed';
    const peak = crashed && round ? Number(round.crash_x100) : liveX100;
    // LINEAR y-axis so e^(0.06t) renders as a pronounced upward parabola. The
    // axis tracks the peak (curve fills the height) and tops out at 50× (5000
    // in ×100), the display ceiling.
    const span = Math.min(5000, Math.max(200, Math.ceil(peak * 1.08)));
    const toY = (x100: number) => H - ((Math.min(x100, span) - 100) / (span - 100)) * (H - 16) - 8;
    // grid lines at 2×,5×,10×,20×,50×…
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (const g of [200, 500, 1000, 2000, 5000]) {
      if (g > span) break;
      const y = toY(g);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // the curve
    const dur = phase === 'running' && round
      ? (Date.now() - Number(BigInt(round.run_started_at) / 1_000_000n))
      : crashed && round ? (Math.log(Number(round.crash_x100) / 100) / 0.06) * 1000 : 0;
    ctx.beginPath();
    ctx.moveTo(0, toY(100));
    const steps = 64;
    for (let i = 1; i <= steps; i++) {
      const ms = (dur * i) / steps;
      const m = multiplierX100(ms);
      ctx.lineTo((W * i) / steps, toY(Math.min(m, span)));
    }
    ctx.strokeStyle = crashed ? '#e5484d' : '#5ed16a';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }, [tick, phase, round, liveX100]);

  const run = async (_label: string, fn: () => Promise<void>) => {
    if (!actor || busy) return;
    setBusy(true); setError(null);
    try { await fn(); await refresh(); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const placeBet = () => run('bet', async () => {
    const chips = BigInt(Math.floor(Number(wager) * 1000)); // VP → chips
    // Auto cash-out off (or blank/invalid) = target 0 = manual only.
    const tNum = Number(targetX);
    const t = !autoCash || !targetX.trim() || !isFinite(tNum) || tNum <= 0 ? 0n : BigInt(Math.round(tNum * 100));
    const res = await actor.crash_bet(chips, t);
    if (res.__kind__ === 'Err') throw new Error(res.Err);
  });

  const cashOut = () => run('cashout', async () => {
    const res = await actor.crash_cashout();
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    beep(880, 0.12, 'square'); // cash register
  });

  const sendChat = () => run('chat', async () => {
    if (!chatText.trim()) return;
    const res = await actor.post_casino_chat(chatText.trim());
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    setChatText('');
  });

  const openVerify = async (item: CrashHistoryItem) => {
    setVerify({ item });
    try {
      const res = await actor.verify_crash_round(item.id);
      const data = res.__kind__ === 'Ok' ? (res.Ok as CrashVerifyView) : undefined;
      const client = item.seed_hex ? await recomputeCrashX100(item.seed_hex) : undefined;
      setVerify({ item, data, client });
    } catch { /* leave dialog with item only */ }
  };

  const myBet = opt<CrashBetView>(round?.my_bet);
  const myBetForBtn = myBet ? {
    outcome: myBet.outcome,
    manual_x100: Number(opt<bigint>(myBet.manual_x100) ?? 0n),
    target_x100: Number(myBet.target_x100),
  } : null;
  const btn = betButton(phase, myBetForBtn, liveX100);

  // Spacebar fires the big button (place / cash out) — unless you're typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!btn.enabled || busy) return;
      e.preventDefault();
      if (btn.action === 'place') placeBet();
      else if (btn.action === 'cashout') cashOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [btn.action, btn.enabled, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const card: React.CSSProperties = { background: 'var(--char-925)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };
  const noVp = signedIn && me !== null && Number(me.chips) === 0;

  // Payout-cap note: if wager × target would exceed 10,000 VP, the bet is
  // auto-cashed at the capped multiplier.
  const capNote = (() => {
    const wagerChips = Math.floor(Number(wager || 0) * 1000);
    const target = Math.round(Number(targetX || 0) * 100);
    if (!autoCash || !targetX.trim()) return 'Manual cash-out — hit SPACE or click CASH OUT during the round. Max payout 10,000 VP/round.';
    if (wagerChips <= 0 || target < 101) return 'Max payout 10,000 VP/round.';
    const eff = effectiveTargetX100(wagerChips, target);
    return eff < target
      ? `Capped → auto-cash at ${fmtX(eff)}× (10,000 VP cap).`
      : `Payout if it hits: ${((wagerChips * eff) / 100 / 1000).toLocaleString()} VP (cap 10,000).`;
  })();

  if (!crashEnabled && !pokerEnabled) {
    return <div style={{ padding: 24 }}><Eyebrow>Casino</Eyebrow><p style={{ color: 'var(--fg-2)' }}>The Casino is currently closed.</p></div>;
  }

  const backBar = (
    <Btn variant="ghost" sm onClick={() => goScreen('hub')} style={{ alignSelf: 'flex-start' }}>
      <Icon name="undo" size={13} /> Casino
    </Btn>
  );

  // ── Hub: a landing page (Explorer-style) with one card per game ──
  if (screen === 'hub' || (screen === 'crash' && !crashEnabled) || (screen === 'poker' && !pokerEnabled)) {
    const gameCard = (
      key: string, name: string, badge: { label: string; tone: 'ok' | 'muted' },
      blurb: string, footL: string, footR: React.ReactNode, go: () => void,
    ) => (
      <div key={key} className="card col hub-card" role="link" tabIndex={0} onClick={go}
        onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
        style={{ gap: 10, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <Chip tone={badge.tone} style={{ height: 19, fontSize: 10 }}><Icon name="zap" size={10} /> {badge.label}</Chip>
        </div>
        <h6 style={{ margin: 0, fontSize: 15, lineHeight: 1.35 }}>{name}</h6>
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1 }}>{blurb}</p>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{footL}</span>
          <span className="mono row" style={{ fontSize: 10.5, color: 'var(--fg-3)', gap: 4 }}>{footR}</span>
        </div>
      </div>
    );
    return (
      <div className="idea-board-container">
        {/* ── Page header (subtitle · title · how it works) ── */}
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Play for voting power</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="zap" size={22} stroke="var(--burn)" />
            <h4 style={{ margin: 0 }}>Casino</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
            Wager your voting power across our games — your staked ICP is never at risk.{' '}
            <MoreInfo title="How the Casino works">
              <p style={{ margin: '0 0 8px' }}>
                Chips are <b>voting power</b> (1 VP = 1,000 chips), earned by staking ICP. Games move only
                this derived number — your staked ICP is never wagered, never at risk, and always
                unstakeable in full. Go broke and your ICP is exactly where you left it.
              </p>
              <p style={{ margin: 0 }}>
                <b>Crash</b> is house-banked with a 1% edge that's burned forever; <b>Poker</b> is
                player-vs-player at 0% rake. A casino-wide stop-loss stands you down before zero.
              </p>
            </MoreInfo>
          </p>
        </div>

        {/* ── Games grid (whole card is clickable) ── */}
        <div className="idea-grid">
          {crashEnabled && gameCard(
            'crash', 'Crash', { label: 'Live', tone: 'ok' },
            'A rising multiplier — cash out before it crashes. Provably fair, 1% edge burned.',
            'house-banked · 1% edge burned',
            <>Watch <Icon name="zap" size={11} /></>,
            () => goScreen('crash'),
          )}
          {pokerEnabled && gameCard(
            'poker', 'Poker', { label: 'Agents only', tone: 'muted' },
            "Caldera Hold'em — your agent plays No-Limit Hold'em while you watch. 0% rake, forever.",
            'No-Limit 25/50 · 0% rake',
            <>{pokerLobby ? `${pokerLobby.players} playing` : 'Watch'} <Icon name="zap" size={11} /></>,
            () => goScreen('poker'),
          )}
        </div>
      </div>
    );
  }

  if (screen === 'poker') {
    return (
      <div className="idea-board-container">
        {backBar}
        <Poker actor={actor} principal={principal} onSignIn={onSignIn} onGoStaking={onGoStaking} />
      </div>
    );
  }

  // ── Crash screen ──
  return (
    <div className="idea-board-container">
      {backBar}
      {/* Page header (subtitle · title · how it works) */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Casino · provably fair</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="zap" size={22} stroke="var(--burn)" />
            <h4 style={{ margin: 0 }}>Crash</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
            Cash out before the rising multiplier crashes. Chips are voting power — your staked ICP is never at risk.{' '}
            <MoreInfo title="How Crash works">
              <p>Chips are your <b>voting power</b> (1 VP = 1,000 chips), derived from your staked ICP. Betting moves only this derived number — your principal is never touched and is always unstakeable in full.</p>
              <p>The house keeps a 1% edge, and <b>burns it</b>: the edge is destroyed forever, not collected. Destroyed VP can only re-enter the system by staking more ICP.</p>
              <p>Every crash point was fixed at genesis by a hash chain — open any past round's <b>verify</b> dialog to recompute it yourself.</p>
            </MoreInfo>
          </p>
        </div>
        <Btn variant="ghost" sm onClick={() => setMuted((m) => !m)}>
          <Icon name={muted ? 'moon' : 'sound'} size={13} /> {muted ? 'Muted' : 'Sound'}
        </Btn>
      </div>

      <div className="casino-grid">
        <div className="casino-graph col" style={{ gap: 16, minWidth: 0 }}>
          <div style={{ ...card, position: 'relative' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontSize: 40, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: phase === 'crashed' ? 'var(--ember)' : 'var(--sprout)' }}>
                {phase === 'crashed' && round ? `${fmtX(Number(round.crash_x100))}×` : `${fmtX(liveX100)}×`}
              </div>
              <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>
                {phase === 'betting' && round && `betting closes in ${Math.max(0, Math.ceil((Number(BigInt(round.phase_deadline) / 1_000_000n) - Date.now()) / 1000))}s`}
                {phase === 'running' && <span><LiveDot color="var(--sprout)" /> live</span>}
                {phase === 'crashed' && round && Number(round.crash_x100) >= 5000 && <span style={{ color: 'var(--haze)' }}>🌙 MOON</span>}
                {phase === 'crashed' && round && <span style={{ color: 'var(--ember)' }}> BUSTED @ {fmtX(Number(round.crash_x100))}×</span>}
                {phase === 'intermission' && 'next round starting…'}
              </div>
            </div>
            <canvas ref={canvasRef} width={680} height={240} style={{ width: '100%', height: 240, marginTop: 8, borderRadius: 8, display: 'block' }} />
          </div>

          {/* History bar — a single line, newest first, clipped (no scroll). */}
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap', overflow: 'hidden' }}>
            {history.slice(0, 16).map((h) => {
              const tone = historyChipTone(Number(h.crash_x100));
              const color = tone === 'gold' ? 'var(--haze)' : tone === 'sprout' ? 'var(--sprout)' : 'var(--ember)';
              return (
                <button key={String(h.id)} onClick={() => openVerify(h)} title="verify"
                  style={{ border: `1px solid ${color}`, color, background: 'transparent', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontVariantNumeric: 'tabular-nums', cursor: 'pointer', flex: '0 0 auto' }}>
                  {fmtX(Number(h.crash_x100))}×
                </button>
              );
            })}
          </div>

        </div>
        <div className="casino-bet col" style={{ gap: 16, minWidth: 0 }}>
          <div style={card}>
            <Eyebrow>Bet</Eyebrow>
            {!signedIn ? (
              <Btn variant="primary" style={{ marginTop: 8 }} onClick={onSignIn}>Sign in to play</Btn>
            ) : noVp ? (
              <div className="col" style={{ gap: 8, marginTop: 8 }}>
                <p style={{ color: 'var(--fg-2)', fontSize: 13 }}>You have no voting power yet. Chips are minted from staked ICP — stake to play (and you can unstake in full anytime).</p>
                <Btn variant="primary" onClick={onGoStaking}>Stake ICP to mint chips →</Btn>
              </div>
            ) : (
              <>
                <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="col" style={{ gap: 4, fontSize: 11, color: 'var(--fg-3)' }}>
                    Wager (VP)
                    <input value={wager} onChange={(e) => setWager(e.target.value)} inputMode="decimal"
                      style={{ width: 120, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} />
                  </label>
                  <div className="col" style={{ gap: 4, fontSize: 11, color: 'var(--fg-3)' }}>
                    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                      Auto cash-out (×)
                      <button onClick={() => setAutoCash((v) => !v)}
                        style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 99, cursor: 'pointer',
                          color: autoCash ? 'var(--char-950)' : 'var(--fg-3)',
                          background: autoCash ? 'var(--sprout)' : 'var(--char-900)',
                          border: '1px solid ' + (autoCash ? 'var(--sprout)' : 'var(--border)') }}>
                        {autoCash ? 'ON' : 'OFF'}
                      </button>
                    </span>
                    <input value={targetX} onChange={(e) => setTargetX(e.target.value)} inputMode="decimal" disabled={!autoCash}
                      placeholder={autoCash ? '2.00' : 'manual'}
                      style={{ width: 120, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)', opacity: autoCash ? 1 : 0.45 }} />
                  </div>
                </div>
                <p style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 6 }}>{capNote}</p>

                {/* Big square, spacebar-driven action button */}
                <button
                  onClick={btn.action === 'place' ? placeBet : btn.action === 'cashout' ? cashOut : undefined}
                  disabled={!btn.enabled || busy}
                  style={{
                    width: '100%', minHeight: 120, marginTop: 12, borderRadius: 16,
                    cursor: btn.enabled && !busy ? 'pointer' : 'default',
                    fontSize: 24, fontWeight: 800, letterSpacing: 0.5,
                    color: btn.enabled ? 'var(--char-950)' : 'var(--fg-3)',
                    background: btn.action === 'cashout' ? 'var(--sprout)' : btn.enabled ? 'var(--burn)' : 'var(--char-900)',
                    border: '1px solid ' + (btn.action === 'cashout' ? 'var(--sprout)' : btn.enabled ? 'var(--burn)' : 'var(--border)'),
                  }}>
                  {btn.label}
                  {btn.enabled && <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.85, marginTop: 8 }}>press SPACE</div>}
                </button>

                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                  <Btn variant="ghost" sm onClick={() => setAutopilotOpen(true)}>
                    <Icon name="refresh" size={13} /> Auto-pilot{autopilot && autopilot.active ? ' · ON' : ''}
                  </Btn>
                  {me && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{Number(me.available_chips).toLocaleString()} chips</span>}
                </div>

                <p style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 8 }}>
                  Manual cash-outs take 1–3 s to land on-chain — set your auto target; the button is for nerves of steel.
                </p>
                {me && (
                  <p style={{ color: 'var(--fg-2)', fontSize: 12, marginTop: 4 }}>
                    Chips available: <b>{Number(me.available_chips).toLocaleString()}</b> ({vpFromE8s(me.effective_vp_e8s)} VP)
                    {Number(me.reserved_chips) > 0 && <span style={{ color: 'var(--fg-3)' }}> · {Number(me.reserved_chips)} reserved this round</span>}
                  </p>
                )}
                {error && <p style={{ color: 'var(--ember)', fontSize: 12, marginTop: 6 }}>{error}</p>}
              </>
            )}
          </div>

          {/* My result strip */}
          {myBet && (
            <div style={{ ...card, borderColor: myBet.outcome === 'won' ? 'var(--sprout)' : myBet.outcome === 'lost' ? 'var(--ember)' : 'var(--border)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>
                  Your bet: {Number(myBet.wager_chips)} chips @ {fmtX(Number(myBet.target_x100))}×
                  {myBet.auto_pilot && <Chip tone="muted" style={{ marginLeft: 6 }}>auto-pilot</Chip>}
                </span>
                <span style={{ fontWeight: 700, color: myBet.outcome === 'won' ? 'var(--sprout)' : myBet.outcome === 'lost' ? 'var(--ember)' : 'var(--fg)' }}>
                  {myBet.outcome === 'won' ? `WON @ ${fmtX(Number(myBet.payout_x100))}×` : myBet.outcome === 'lost' ? 'BUSTED' : 'riding…'}
                </span>
              </div>
              {myBet.outcome === 'lost' && (
                <p style={{ color: 'var(--fg-3)', fontSize: 12, marginTop: 6 }}>
                  Your staked ICP is exactly where you left it. <button onClick={onGoStaking} style={{ background: 'none', border: 'none', color: 'var(--burn)', cursor: 'pointer', padding: 0 }}>Stake more to mint chips →</button>
                </p>
              )}
            </div>
          )}

        </div>
        <div className="casino-players" style={{ minWidth: 0 }}>
          {/* Players table — riding at top (by bet), cashed-out stack at the
              bottom and re-arrange live as players hit their stop. */}
          <div style={{ ...card, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Eyebrow>Players · this round</Eyebrow>
            {(() => {
              const rows = (round?.players ?? []).map((p, i) => {
                const wagerChips = Number(p.wager_chips);
                const target = Number(p.target_x100);
                const manual = Number(opt<bigint>(p.manual_x100) ?? 0n);
                const effStop = effectiveTargetX100(wagerChips, target);
                const settledWon = p.outcome === 'won';
                const settledLost = p.outcome === 'lost';
                // Mid-run, a player has cashed once live passes their stop (or
                // they manually bailed) — even though the canister settles at crash.
                const cashedRunning = phase === 'running' && !settledWon && !settledLost && (manual > 0 || liveX100 >= effStop);
                let state: 'riding' | 'cashed' | 'busted' = 'riding';
                let cashMult = 0;
                let profitVp = 0;
                if (settledWon) { state = 'cashed'; cashMult = Number(p.payout_x100); }
                else if (settledLost) { state = 'busted'; profitVp = -wagerChips / 1000; }
                else if (cashedRunning) { state = 'cashed'; cashMult = manual > 0 ? manual : effStop; }
                if (state === 'cashed') profitVp = (wagerChips * (cashMult - 100)) / 100 / 1000;
                const done = state !== 'riding';
                return { key: p.user.toString() + i, p, wagerChips, cashMult, state, profitVp, done };
              });
              rows.sort((a, b) => {
                if (a.done !== b.done) return a.done ? 1 : -1;          // riding first
                if (!a.done) return b.wagerChips - a.wagerChips;        // riding by bet desc
                const aBust = a.state === 'busted' ? 1 : 0, bBust = b.state === 'busted' ? 1 : 0;
                if (aBust !== bBust) return aBust - bBust;              // cashed above busted
                return b.profitVp - a.profitVp;                        // best cashouts first
              });
              const fmtVp = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
              // Row highlight: profited = green, lost = red, still riding = gray.
              const bgFor = (s: string) => s === 'cashed' ? 'var(--sprout-dim)' : s === 'busted' ? 'var(--ember-dim)' : 'transparent';
              const fgFor = (s: string) => s === 'cashed' ? 'var(--sprout)' : s === 'busted' ? 'var(--ember)' : 'var(--fg-2)';
              return (
                <div className="col" style={{ marginTop: 8, fontSize: 12, flex: 1, minHeight: 0, overflowY: 'auto' }}>
                  <div className="row" style={{ color: 'var(--fg-3)', padding: '2px 6px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ flex: '2 1 0' }}>Principal</span>
                    <span style={{ flex: '1 1 0', textAlign: 'right' }}>Stop</span>
                    <span style={{ flex: '1 1 0', textAlign: 'right' }}>Bet</span>
                    <span style={{ flex: '1 1 0', textAlign: 'right' }}>Profit</span>
                  </div>
                  {rows.length === 0 && <span style={{ color: 'var(--fg-3)', padding: '6px 0' }}>No bets yet.</span>}
                  {rows.map((r) => (
                    <div key={r.key} className="row" style={{ padding: '3px 6px', borderRadius: 4, color: fgFor(r.state), background: bgFor(r.state), fontVariantNumeric: 'tabular-nums', transition: 'background 0.2s' }}>
                      <span style={{ flex: '2 1 0', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {formatPrincipal(Principal.fromText(r.p.user.toString()))}{r.p.auto_pilot ? ' 🤖' : ''}
                      </span>
                      {/* Stop hidden until the player has actually cashed out. */}
                      <span style={{ flex: '1 1 0', textAlign: 'right' }}>{r.state === 'cashed' ? `${fmtX(r.cashMult)}×` : '—'}</span>
                      <span style={{ flex: '1 1 0', textAlign: 'right' }}>{fmtVp(r.wagerChips / 1000)}</span>
                      <span style={{ flex: '1 1 0', textAlign: 'right' }}>
                        {r.state === 'riding' ? '—' : `${r.profitVp >= 0 ? '+' : ''}${fmtVp(r.profitVp)}`}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
        <div className="casino-chat" style={{ minWidth: 0 }}>
          {/* Chat + History tabs — directly below the game */}
          <div style={card}>
            <div className="row" style={{ gap: 6 }}>
              <Btn variant={chatTab === 'chat' ? 'primary' : 'ghost'} sm onClick={() => setChatTab('chat')}>Chat</Btn>
              <Btn variant={chatTab === 'history' ? 'primary' : 'ghost'} sm onClick={() => setChatTab('history')}>History</Btn>
            </div>

            {chatTab === 'chat' ? (
              <>
                <div className="col" style={{ gap: 3, marginTop: 10, maxHeight: 260, overflowY: 'auto', fontSize: 12 }}>
                  {chat.length === 0 && <span style={{ color: 'var(--fg-3)' }}>Say hi 👋</span>}
                  {chat.map((m) => (
                    <div key={String(m.id)}>
                      <span style={{ color: 'var(--fg-3)' }}>{formatPrincipal(Principal.fromText(m.author.toString()))}:</span>{' '}
                      <span style={{ color: 'var(--fg-2)' }}>{m.text}</span>
                    </div>
                  ))}
                </div>
                {signedIn && (
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <input value={chatText} onChange={(e) => setChatText(e.target.value)} maxLength={200}
                      onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }} placeholder="message (200)"
                      style={{ flex: 1, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} />
                    <Btn variant="secondary" sm disabled={busy} onClick={sendChat}>Send</Btn>
                  </div>
                )}
              </>
            ) : (
              <div className="col" style={{ marginTop: 10, maxHeight: 320, overflowY: 'auto', fontSize: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between', color: 'var(--fg-3)', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>
                  <span>Round</span><span>Multiplier</span><span>Verify</span>
                </div>
                {history.length === 0 && <span style={{ color: 'var(--fg-3)', padding: '6px' }}>No rounds yet.</span>}
                {history.map((h) => {
                  const tone = historyChipTone(Number(h.crash_x100));
                  const color = tone === 'gold' ? 'var(--haze)' : tone === 'sprout' ? 'var(--sprout)' : 'var(--ember)';
                  return (
                    <button key={String(h.id)} onClick={() => openVerify(h)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--fg-2)', padding: '5px 6px', cursor: 'pointer', fontSize: 12 }}>
                      <span style={{ color: 'var(--fg-3)' }}>#{String(h.id)}</span>
                      <span style={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtX(Number(h.crash_x100))}×</span>
                      <Icon name="check" size={12} stroke={color} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Auto-pilot modal */}
      {autopilotOpen && (
        <div onClick={() => setAutopilotOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, maxWidth: 440, width: '90%' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <Eyebrow accent>Auto-pilot</Eyebrow>
              <Btn variant="ghost" sm onClick={() => setAutopilotOpen(false)}><Icon name="x" size={13} /></Btn>
            </div>
            {autopilot && autopilot.active ? (
              <div className="col" style={{ gap: 8, marginTop: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>
                  Running · {Number(autopilot.rounds_played)} rounds · net {vpFromE8s(autopilot.session_pnl_e8s)} VP
                </span>
                <Btn variant="secondary" onClick={() => run('stopap', async () => { await actor.stop_autopilot(); })}>STOP auto-pilot</Btn>
              </div>
            ) : (
              <div className="col" style={{ gap: 6, marginTop: 10 }}>
                {autopilot?.stop_reason && opt<string>(autopilot.stop_reason) && (
                  <span style={{ fontSize: 11, color: 'var(--haze)' }}>stopped: {opt<string>(autopilot.stop_reason)}</span>
                )}
                {strategies.map((s) => (
                  <div key={String(s.id)} className="row" style={{ justifyContent: 'space-between', fontSize: 13, alignItems: 'center' }}>
                    <span>{s.name} {s.builtin && <Chip tone="muted">builtin</Chip>}</span>
                    <Btn variant="ghost" sm onClick={() => run('startap', async () => {
                      const res = await actor.start_autopilot(s.id);
                      if (res.__kind__ === 'Err') throw new Error(res.Err);
                      setAutopilotOpen(false);
                    })}>Run</Btn>
                  </div>
                ))}
                <p style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 4 }}>Past variance is not edge — every strategy has −1% expectation. Buy style, not magic.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Verify dialog */}
      {verify && (
        <div onClick={() => setVerify(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, maxWidth: 480, width: '90%' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <Eyebrow accent>Verify round #{String(verify.item.id)}</Eyebrow>
              <Btn variant="ghost" sm onClick={() => setVerify(null)}><Icon name="x" size={13} /></Btn>
            </div>
            <div className="col" style={{ gap: 6, marginTop: 10, fontSize: 12, color: 'var(--fg-2)' }}>
              <div>Crash point: <b>{fmtX(Number(verify.item.crash_x100))}×</b></div>
              <div>Chain index: {String(verify.item.chain_index)}</div>
              <div style={{ wordBreak: 'break-all' }}>Seed: <span style={{ color: 'var(--fg-3)' }}>{verify.item.seed_hex || '(unrevealed)'}</span></div>
              {verify.client !== undefined && (
                <div>Recomputed client-side: <b style={{ color: verify.client === Number(verify.item.crash_x100) ? 'var(--sprout)' : 'var(--ember)' }}>{fmtX(verify.client)}× {verify.client === Number(verify.item.crash_x100) ? '✓' : '✗'}</b></div>
              )}
              {verify.data && (
                <div>Chain link to genesis: <b style={{ color: verify.data.chain_verified ? 'var(--sprout)' : 'var(--ember)' }}>{verify.data.chain_verified ? 'verified ✓' : 'FAILED ✗'}</b></div>
              )}
            </div>
          </div>
        </div>
      )}

      {isLocal && (
        <p style={{ color: 'var(--fg-3)', fontSize: 11 }}>
          Local note: paid flows (strategy creation, marketplace) require an icrc2_approve to the canister first.
        </p>
      )}
    </div>
  );
}
