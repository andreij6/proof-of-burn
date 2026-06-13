import { useEffect, useRef, useState, useCallback } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import type {
  CrashRoundView, CrashBetView, CrashHistoryItem, CrashVerifyView,
  CasinoStatsView, MyCasinoView, ChatMsgView, CrashStrategy, AutopilotState,
} from './bindings/backend';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal } from './ui';
import {
  multiplierX100, fmtX, historyChipTone, betButton, recomputeCrashX100, type BetPhase,
} from './crashMath';

interface CasinoProps {
  actor: any;
  principal: Principal | null;
  isLocal: boolean;
  onSignIn: () => void;
  /** Jump to the Staking tab — chips come from staking. */
  onGoStaking: () => void;
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

export default function Casino({ actor, principal, isLocal, onSignIn, onGoStaking }: CasinoProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [round, setRound] = useState<CrashRoundView | null>(null);
  const [history, setHistory] = useState<CrashHistoryItem[]>([]);
  const [stats, setStats] = useState<CasinoStatsView | null>(null);
  const [me, setMe] = useState<MyCasinoView | null>(null);
  const [chat, setChat] = useState<ChatMsgView[]>([]);
  const [strategies, setStrategies] = useState<CrashStrategy[]>([]);
  const [autopilot, setAutopilot] = useState<AutopilotState | null>(null);
  const [wager, setWager] = useState('100');
  const [targetX, setTargetX] = useState('2.00');
  const [chatText, setChatText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0); // drives the live curve at ~10fps
  const [verify, setVerify] = useState<{ item: CrashHistoryItem; data?: CrashVerifyView; client?: number } | null>(null);
  const [muted, setMuted] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  const phase = (round?.phase ?? 'intermission') as BetPhase;

  const refresh = useCallback(async () => {
    if (!actor) return;
    try {
      const [r, h, s] = await Promise.all([
        actor.get_crash_round(),
        actor.get_crash_history(20n),
        actor.get_casino_stats(),
      ]);
      setRound(r);
      setHistory(h);
      setStats(s);
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

  // Poll: 1 s while a round runs, 3 s otherwise (the curve itself is local math).
  useEffect(() => {
    refresh();
    const ms = phase === 'running' || phase === 'betting' ? 1000 : 3000;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [refresh, phase]);

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
    const span = Math.max(300, peak * 1.15); // y axis scales with the run
    const toY = (x100: number) => H - (Math.log(x100 / 100) / Math.log(span / 100)) * (H - 16) - 8;
    // grid lines at 2×,5×,10×…
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (const g of [200, 500, 1000, 2000, 5000, 10000]) {
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
    const w = BigInt(Math.floor(Number(wager)));
    const t = BigInt(Math.round(Number(targetX) * 100));
    const res = await actor.crash_bet(w, t);
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

  const card: React.CSSProperties = { background: 'var(--char-925)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };

  if (stats && !stats.crash_enabled) {
    return <div style={{ padding: 24 }}><Eyebrow>Casino</Eyebrow><p style={{ color: 'var(--fg-2)' }}>The Casino is currently closed.</p></div>;
  }

  return (
    <div className="col" style={{ gap: 16, paddingBottom: 40 }}>
      {/* Hub header + doctrine (C16) */}
      <div style={{ ...card, borderColor: 'var(--burn)' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <Icon name="zap" size={18} stroke="var(--burn)" />
            <Eyebrow accent>Casino · Crash</Eyebrow>
            {stats?.chain_initialized && <Chip tone="ok">provably fair</Chip>}
          </div>
          <Btn variant="ghost" sm onClick={() => setMuted((m) => !m)}>
            <Icon name={muted ? 'moon' : 'sound'} size={13} /> {muted ? 'Muted' : 'Sound'}
          </Btn>
        </div>
        <p style={{ color: 'var(--fg-2)', fontSize: 13, margin: '10px 0 0' }}>{NO_LOSS_DOCTRINE}</p>
        <MoreInfo title="How the Casino works" style={{ marginTop: 8 }}>
          <p>Chips are your <b>voting power</b> (1 VP = 1,000 chips), derived from your staked ICP. Betting moves only this derived number — your principal is never touched and is always unstakeable in full.</p>
          <p>The house keeps a 1% edge, and <b>burns it</b>: the edge is destroyed forever, not collected. Destroyed VP can only re-enter the system by staking more ICP.</p>
          <p>Every crash point was fixed at genesis by a hash chain — open any past round's <b>verify</b> dialog to recompute it yourself.</p>
        </MoreInfo>
      </div>

      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Graph + history + bet panel + players */}
        <div className="col" style={{ gap: 16, flex: '2 1 520px', minWidth: 320 }}>
          <div style={{ ...card, position: 'relative' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontSize: 40, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: phase === 'crashed' ? 'var(--ember)' : 'var(--sprout)' }}>
                {phase === 'crashed' && round ? `${fmtX(Number(round.crash_x100))}×` : `${fmtX(liveX100)}×`}
              </div>
              <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>
                {phase === 'betting' && round && `betting closes in ${Math.max(0, Math.ceil((Number(BigInt(round.phase_deadline) / 1_000_000n) - Date.now()) / 1000))}s`}
                {phase === 'running' && <span><LiveDot color="var(--sprout)" /> live</span>}
                {phase === 'crashed' && round && Number(round.crash_x100) >= 10000 && <span style={{ color: 'var(--haze)' }}>🌙 MOON</span>}
                {phase === 'crashed' && round && <span style={{ color: 'var(--ember)' }}> BUSTED @ {fmtX(Number(round.crash_x100))}×</span>}
                {phase === 'intermission' && 'next round starting…'}
              </div>
            </div>
            <canvas ref={canvasRef} width={680} height={240} style={{ width: '100%', height: 240, marginTop: 8, borderRadius: 8, display: 'block' }} />
          </div>

          {/* History bar */}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {history.map((h) => {
              const tone = historyChipTone(Number(h.crash_x100));
              const color = tone === 'gold' ? 'var(--haze)' : tone === 'sprout' ? 'var(--sprout)' : 'var(--ember)';
              return (
                <button key={String(h.id)} onClick={() => openVerify(h)} title="verify"
                  style={{ border: `1px solid ${color}`, color, background: 'transparent', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
                  {fmtX(Number(h.crash_x100))}×
                </button>
              );
            })}
          </div>

          {/* Bet panel */}
          <div style={card}>
            <Eyebrow>Bet</Eyebrow>
            {!signedIn ? (
              <Btn variant="primary" style={{ marginTop: 8 }} onClick={onSignIn}>Sign in to play</Btn>
            ) : (
              <>
                <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                  <label className="col" style={{ gap: 4, fontSize: 11, color: 'var(--fg-3)' }}>
                    Wager (chips)
                    <input value={wager} onChange={(e) => setWager(e.target.value)} inputMode="numeric"
                      style={{ width: 110, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} />
                    <span style={{ color: 'var(--fg-3)' }}>≈ {(Number(wager || 0) / 1000).toFixed(3)} VP</span>
                  </label>
                  <label className="col" style={{ gap: 4, fontSize: 11, color: 'var(--fg-3)' }}>
                    Auto cash-out (×)
                    <input value={targetX} onChange={(e) => setTargetX(e.target.value)} inputMode="decimal"
                      style={{ width: 90, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} />
                  </label>
                  <div className="col" style={{ justifyContent: 'flex-end' }}>
                    <Btn variant={btn.action === 'cashout' ? 'primary' : 'primary'} disabled={!btn.enabled || busy}
                      onClick={btn.action === 'place' ? placeBet : btn.action === 'cashout' ? cashOut : undefined}>
                      {btn.label}
                    </Btn>
                  </div>
                </div>
                <p style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 8 }}>
                  Manual cash-outs take 1–3 s to land on-chain — set your auto target; the button is for nerves of steel. Your auto target is the latency-fair primary mechanism.
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

          {/* Players list */}
          <div style={card}>
            <Eyebrow>Players · this round</Eyebrow>
            <div className="col" style={{ gap: 4, marginTop: 8 }}>
              {(round?.players ?? []).length === 0 && <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>No bets yet.</span>}
              {(round?.players ?? []).map((p, i) => {
                const m = Number(opt<bigint>(p.manual_x100) ?? 0n);
                const col = p.outcome === 'won' ? 'var(--sprout)' : p.outcome === 'lost' ? 'var(--ember)' : 'var(--fg-2)';
                return (
                  <div key={i} className="row" style={{ justifyContent: 'space-between', fontSize: 12, color: col }}>
                    <span>{formatPrincipal(Principal.fromText(p.user.toString()))} {p.auto_pilot && '🤖'}</span>
                    <span>{Number(p.wager_chips)} @ {fmtX(Number(p.target_x100))}× {p.outcome === 'won' ? `✓ ${fmtX(Number(p.payout_x100))}×` : m > 0 ? `out ${fmtX(m)}×` : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right rail: autopilot + chat + stats */}
        <div className="col" style={{ gap: 16, flex: '1 1 280px', minWidth: 260 }}>
          {signedIn && (
            <div style={card}>
              <Eyebrow>Auto-pilot</Eyebrow>
              {autopilot && autopilot.active ? (
                <div className="col" style={{ gap: 6, marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                    Running · {Number(autopilot.rounds_played)} rounds · net {vpFromE8s(autopilot.session_pnl_e8s)} VP
                  </span>
                  <Btn variant="secondary" sm onClick={() => run('stopap', async () => { await actor.stop_autopilot(); })}>STOP</Btn>
                </div>
              ) : (
                <div className="col" style={{ gap: 6, marginTop: 8 }}>
                  {autopilot?.stop_reason && opt<string>(autopilot.stop_reason) && (
                    <span style={{ fontSize: 11, color: 'var(--haze)' }}>stopped: {opt<string>(autopilot.stop_reason)}</span>
                  )}
                  {strategies.map((s) => (
                    <div key={String(s.id)} className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                      <span>{s.name} {s.builtin && <Chip tone="muted">builtin</Chip>}</span>
                      <Btn variant="ghost" sm onClick={() => run('startap', async () => {
                        const res = await actor.start_autopilot(s.id);
                        if (res.__kind__ === 'Err') throw new Error(res.Err);
                      })}>Run</Btn>
                    </div>
                  ))}
                  <p style={{ color: 'var(--fg-3)', fontSize: 11 }}>Past variance is not edge — every strategy has −1% expectation. Buy style, not magic.</p>
                </div>
              )}
            </div>
          )}

          {/* Chat */}
          <div style={card}>
            <Eyebrow>Casino chat</Eyebrow>
            <div className="col" style={{ gap: 3, marginTop: 8, maxHeight: 220, overflowY: 'auto', fontSize: 12 }}>
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
          </div>

          {/* Stats */}
          {stats && (
            <div style={card}>
              <Eyebrow>House</Eyebrow>
              <div className="col" style={{ gap: 4, marginTop: 8, fontSize: 12, color: 'var(--fg-2)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}><span>Lifetime burned</span><b>{vpFromE8s(stats.lifetime_burned_vp_e8s)} VP</b></div>
                <div className="row" style={{ justifyContent: 'space-between' }}><span>House balance</span><span>{vpFromE8s(stats.house_vp_e8s)} VP</span></div>
                <p style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 4 }}>The 1% house edge is destroyed forever, not collected.</p>
              </div>
            </div>
          )}
        </div>
      </div>

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
